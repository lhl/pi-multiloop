import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  type LaneId,
  type RegistryEntry,
  getLoop,
  registerLoop,
  updateLoopStatus,
  ensureLaneDir,
  generateRunTag,
  parseLaneId,
  formatLaneId,
  archiveLoop as archiveLaneDirs,
  deleteLaneDirs,
  readRegistry,
} from "./lanes.js";
import {
  type LoopState,
  createInitialState,
  saveState,
  loadState,
  reconstructState,
  appendResult,
} from "./state.js";
import {
  assessConfidence,
  isImprovement,
  formatDelta,
  confidenceLabel,
} from "./metrics.js";
import {
  decide,
  failureEscalationDecision,
  applyDecision,
  shouldReanchor,
  reanchor,
  buildIterationContext,
  buildEscalationPrompt,
} from "./loop.js";
import { MODES, detectMode, type LoopMode } from "./modes.js";
import {
  assessAcceptance,
  ensureRequiredChecks,
  formatVerificationChecks,
  normalizeVerificationChecks,
} from "./verifiers.js";

const activeStates = new Map<string, LoopState>();
const COMPACTION_RESUME_RECENT_MS = 5000;
let agentRunning = false;
let resumeAfterCompact = false;
let lastCompactionEntryId: string | undefined;
let pendingCompactionResumeTiming: CompactionResumeTiming | undefined;
let lastActiveAgentEndAt = 0;
let lastInputAt = 0;
let loopTurnActive = false;
let loopTurnReason: string | undefined;

function stateKey(id: LaneId): string {
  return `${id.lane}/${id.runTag}`;
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

function runningStates(): LoopState[] {
  return Array.from(activeStates.values()).filter((state) => state.status === "running");
}

function markLoopTurn(reason: string): void {
  loopTurnActive = true;
  loopTurnReason = reason;
}

function sameMeasurements(a: number[] | undefined, b: number[]): boolean {
  return Array.isArray(a) && a.length === b.length && a.every((value, index) => value === b[index]);
}

function shouldContinueAfterUserInput(text: string): boolean {
  if (runningStates().length === 0) return false;
  const lower = text.trim().toLowerCase();
  if (!lower) return false;
  if (lower.startsWith("/")) return false;

  const asksToSuspend = /\b(stop|pause|halt|suspend|disable|archive|delete|remove)\b.*\b(loop|multiloop|iteration|work)\b/.test(lower) ||
    /\b(loop|multiloop|iteration|work)\b.*\b(stop|pause|halt|suspend|disable|archive|delete|remove)\b/.test(lower) ||
    /\b(do not|don't|dont)\s+continue\b/.test(lower);
  return !asksToSuspend;
}

function activeIterationSummary(state: LoopState): string {
  if (state.baseline === null) {
    return `- ${state.lane}/${state.runTag}: baseline is not recorded. Run verify \`${state.verifyCommand}\`, then call multiloop_measure to persist the baseline.`;
  }

  const active = state.activeIteration;
  const promptCheck = state.promptVerifier ? " and run the prompt verifier" : "";
  const checkInstruction = state.guardCommand || state.promptVerifier
    ? " Include all mechanical/prompt check verdicts in multiloop_measure.checks."
    : "";

  if (!active) {
    return `- ${state.lane}/${state.runTag}: no iteration is in progress. Call multiloop_iterate, make one focused change, run verify${state.guardCommand ? " and guard" : ""}${promptCheck}, then call multiloop_measure.${checkInstruction}`;
  }

  if (active.phase === "started") {
    return `- ${state.lane}/${state.runTag}: iteration ${active.iteration} is started but not measured. Run verify \`${state.verifyCommand}\`${state.guardCommand ? ` and guard \`${state.guardCommand}\`` : ""}${promptCheck}, then call multiloop_measure.${checkInstruction}`;
  }

  const acceptanceStatus = active.acceptancePassed === undefined
    ? "UNKNOWN"
    : active.acceptancePassed ? "PASS" : "FAIL";
  return `- ${state.lane}/${state.runTag}: iteration ${active.iteration} has measurements [${active.measurements?.join(", ") ?? ""}] and acceptance ${acceptanceStatus}; if the user asked a question, answer it, then complete the pending iteration with multiloop_decide action="${active.recommendedAction ?? "log"}".`;
}

export type CompactionResumeTiming = "skip" | "after-current-agent-end" | "after-compaction";

export interface CompactionResumeTimingInput {
  hasRunningStates: boolean;
  agentRunning: boolean;
  isIdle: boolean;
  now: number;
  lastActiveAgentEndAt: number;
  lastInputAt: number;
  recentWindowMs?: number;
}

export function decideCompactionResumeTiming(input: CompactionResumeTimingInput): CompactionResumeTiming {
  if (!input.hasRunningStates) return "skip";
  if (input.agentRunning) return "after-current-agent-end";

  const recentWindowMs = input.recentWindowMs ?? COMPACTION_RESUME_RECENT_MS;
  const followsRecentInput =
    input.lastInputAt > input.lastActiveAgentEndAt && input.now - input.lastInputAt <= recentWindowMs;
  if (followsRecentInput) {
    // Pi can compact before submitting a freshly typed/extension-injected prompt.
    // In that case the prompt that caused the preflight compaction will continue
    // normally, so injecting an additional resume would duplicate work.
    return "skip";
  }

  const followsRecentAgentEnd =
    input.lastActiveAgentEndAt > 0 && input.now - input.lastActiveAgentEndAt <= recentWindowMs;
  if (followsRecentAgentEnd) return "after-compaction";

  // Defensive fallback for compaction implementations that emit while the agent
  // is still busy but before agent_start/agent_end bookkeeping has caught up.
  if (!input.isIdle) return "after-current-agent-end";

  // Manual /compact while idle should not restart the agent.
  return "skip";
}

function queueCompactionResume(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  compactionEntryId?: string
): void {
  const states = runningStates();
  if (states.length === 0 || ctx.hasPendingMessages()) return;

  setTimeout(() => {
    const latestStates = runningStates();
    if (latestStates.length === 0) return;
    if (ctx.hasPendingMessages()) return;
    try {
      markLoopTurn("compaction-resume");
      pi.sendUserMessage(buildCompactionResumePrompt(latestStates, compactionEntryId), { deliverAs: "followUp" });
    } catch (err) {
      ctx.ui.notify(`multiloop resume after compact failed: ${(err as Error).message}`, "error");
    }
  }, 0);
}

function queueLoopAutoContinue(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  reason: string
): void {
  const states = runningStates();
  if (states.length === 0 || ctx.hasPendingMessages()) return;

  setTimeout(() => {
    const latestStates = runningStates();
    if (latestStates.length === 0) return;
    if (ctx.hasPendingMessages()) return;
    try {
      markLoopTurn(`auto-continue:${reason}`);
      pi.sendUserMessage(buildAutoContinuePrompt(latestStates), { deliverAs: "followUp" });
    } catch (err) {
      ctx.ui.notify(`multiloop auto-continue failed: ${(err as Error).message}`, "error");
    }
  }, 0);
}

function buildLoopResumePrompt(
  heading: string,
  states: LoopState[],
  compactionEntryId?: string
): string {
  const contexts = states.map((state) => buildIterationContext(state)).join("\n\n");
  return [
    heading,
    compactionEntryId ? `Compaction entry: ${compactionEntryId}` : undefined,
    "",
    "Do not start a new loop and do not ask for confirmation. Resume from the persisted .multiloop state exactly where the loop left off.",
    "This is a continuation contract: answer any explicit user status/query briefly if needed, then resume loop work while any listed loop remains running.",
    "A verification is recorded only after multiloop_measure persists it; an iteration is complete only after multiloop_decide or multiloop_log updates state/results.",
    "",
    contexts,
    "",
    "Next:",
    "- If baseline is missing, run the verify command and call multiloop_measure to persist it.",
    "- If an active iteration is measured, call multiloop_decide or multiloop_log with the recorded measurements before doing anything else.",
    "- If an iteration was not in progress, call multiloop_iterate for the appropriate lane.",
    "- Run the loop's verify command, guard command if present, and prompt verifier if configured.",
    "- Record metric measurements and all mechanical/prompt check verdicts with multiloop_measure, then finish with multiloop_decide or multiloop_log.",
    "- If the loop is still running after decide/log, continue into the next iteration instead of ending with only a summary.",
    "- If state is ambiguous, inspect .multiloop/active/<lane>/<runTag>/state.json and results.jsonl before proceeding.",
  ].filter((line): line is string => line !== undefined).join("\n");
}

export function buildExplicitResumePrompt(states: LoopState[]): string {
  return buildLoopResumePrompt("Resume active pi-multiloop work from persisted state.", states);
}

export function buildCompactionResumePrompt(
  states: LoopState[],
  compactionEntryId?: string
): string {
  return buildLoopResumePrompt(
    "Continue active pi-multiloop work after context compaction.",
    states,
    compactionEntryId
  );
}

export function buildAutoContinuePrompt(states: LoopState[]): string {
  const contexts = states.map((state) => buildIterationContext(state)).join("\n\n");
  const nextActions = states.map(activeIterationSummary).join("\n");
  return [
    "Continue active pi-multiloop work.",
    "",
    "Continuation policy:",
    "- If the user asked a status question or other query, answer it first.",
    "- If the listed loop is still running after that answer, resume the next loop action; if it is stopped/paused, do not force more loop tools.",
    "- Next loop action is usually: verify/guard/prompt verifier, multiloop_measure, then multiloop_decide or multiloop_log.",
    "- A bash verify output alone is not recorded; persist measurements and all mechanical/prompt check verdicts through multiloop_measure.",
    "",
    contexts,
    "",
    "Required next action:",
    nextActions,
  ].join("\n");
}

export function buildSetupGuidePrompt(): string {
  return [
    "Help me create a high-quality pi-multiloop run.",
    "",
    "Use the loop setup guide contract:",
    "1. Scan the repo before proposing a loop: inspect the directory structure and relevant manifests/scripts/configs. Do not edit files during setup.",
    "2. Ask at least one repo-grounded clarification round before launch, even if the request seems obvious. Prefer concrete defaults and multiple-choice questions.",
    "3. Infer and confirm: goal, mode, lane, scope, metric name, metric direction, verify command, guard command, prompt verifier, acceptance policy, stop condition/iteration cap, and rollback safety.",
    "4. For compound goals like performance improves while output remains correct, configure a metric verify command plus mechanical/prompt checks. Acceptance should be: metric improves and every check passes.",
    "5. Present a short confirmation summary with concrete commands and current baseline plan. Do not start the loop until I explicitly reply go/start/launch.",
    "6. After approval, call multiloop_start with the confirmed config. Do not ask another question after approval unless a true safety blocker appears.",
    "",
    "Confirmation format:",
    "**Proposed loop**",
    "- Target: ...",
    "- Metric: ... (direction: lower/higher)",
    "- Verify: `...`",
    "- Guard/checks: `...` plus prompt verifier if needed",
    "- Scope/lane: ...",
    "- Stop condition: ...",
    "",
    "**Need to confirm**",
    "- Only genuine blockers or choices.",
    "",
    "**Next step**",
    "- Reply go to start, or tell me what to change.",
  ].join("\n");
}

function loopSummary(cwd: string, entry: RegistryEntry): string {
  const state = loadState(cwd, { lane: entry.lane, runTag: entry.runTag });
  const parts: string[] = [`${entry.lane}/${entry.runTag}`];

  if (state?.goal) {
    const goal = state.goal.length > 60 ? state.goal.slice(0, 57) + "..." : state.goal;
    parts.push(`"${goal}"`);
  }

  const details: string[] = [entry.mode];
  if (state && state.iteration > 0) {
    details.push(`${state.iteration} iter`);
  }
  if (state != null && state.baseline !== null && state.bestMetric !== null && state.baseline !== state.bestMetric) {
    details.push(`${state.baseline} → ${state.bestMetric}`);
  }
  parts.push(`(${details.join(", ")})`);

  return parts.join(" — ");
}

interface ResumableLoopsNoticeStyle {
  title?: (text: string) => string;
  rule?: (text: string) => string;
  loopId?: (text: string) => string;
  badge?: (text: string) => string;
  goal?: (text: string) => string;
  command?: (text: string) => string;
  arrow?: (text: string) => string;
  status?: (text: string) => string;
  separator?: (text: string) => string;
  muted?: (text: string) => string;
}

interface ResumableLoopsNoticeTheme {
  fg?: (name: string, text: string) => string;
  bold?: (text: string) => string;
}

function styleText(
  styles: ResumableLoopsNoticeStyle,
  key: keyof ResumableLoopsNoticeStyle,
  text: string
): string {
  const style = styles[key];
  return style ? style(text) : text;
}

function truncateDisplay(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - 1)).trimEnd() + "…";
}

function extractQuotedOption(input: string, labels: string[]): string | undefined {
  const alternation = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const backtick = input.match(new RegExp(`(?:${alternation})[:\\s]+\\\`([^\\\`]+)\\\``, "i"));
  if (backtick) return backtick[1];
  const quoted = input.match(new RegExp(`(?:${alternation})[:\\s]+"([^"]+)"`, "i"));
  return quoted?.[1];
}

function themeFg(theme: ResumableLoopsNoticeTheme, name: string, text: string): string {
  try {
    return theme.fg?.(name, text) ?? text;
  } catch {
    return text;
  }
}

function themeBold(theme: ResumableLoopsNoticeTheme, text: string): string {
  try {
    return theme.bold?.(text) ?? text;
  } catch {
    return text;
  }
}

function noticeStyles(theme: ResumableLoopsNoticeTheme): ResumableLoopsNoticeStyle {
  return {
    title: (text) => themeFg(theme, "mdHeading", themeBold(theme, text)),
    rule: (text) => themeFg(theme, "mdHr", text),
    loopId: (text) => themeFg(theme, "accent", text),
    badge: (text) => themeFg(theme, "muted", text),
    goal: (text) => themeFg(theme, "text", text),
    command: (text) => themeFg(theme, "syntaxFunction", text),
    arrow: (text) => themeFg(theme, "mdHr", text),
    status: (text) => themeFg(theme, "mdLink", text),
    separator: (text) => themeFg(theme, "mdHr", text),
    muted: (text) => themeFg(theme, "muted", text),
  };
}

export function colorizeResumableLoopsNotice(content: string, theme: ResumableLoopsNoticeTheme): string {
  const styles = noticeStyles(theme);
  return content.split("\n").map((line) => {
    const header = line.match(/^(━━) (pi-multiloop) (━+) (.+?) (━━)$/);
    if (header) {
      const status = header[4].split(" · ");
      const styledStatus = status.length === 2
        ? `${styleText(styles, "status", status[0])} ${styleText(styles, "separator", "·")} ${styleText(styles, "status", status[1])}`
        : styleText(styles, "status", header[4]);
      return [
        styleText(styles, "rule", header[1]),
        styleText(styles, "title", header[2]),
        styleText(styles, "rule", header[3]),
        styledStatus,
        styleText(styles, "rule", header[5]),
      ].join(" ");
    }

    const loop = line.match(/^( ·) (\S+)(\s+)(\[ [^\]]+ \]) (\[ [^\]]+ \])$/);
    if (loop) {
      return `${styleText(styles, "arrow", loop[1])} ${styleText(styles, "loopId", loop[2])}${loop[3]}${styleText(styles, "badge", loop[4])} ${styleText(styles, "badge", loop[5])}`;
    }

    const goal = line.match(/^(    )(".*")$/);
    if (goal) return `${goal[1]}${styleText(styles, "goal", goal[2])}`;

    const command = line.match(/^(❯)  (\/multiloop resume) (<lane\/run-tag>)$/);
    if (command) {
      return `${styleText(styles, "arrow", command[1])}  ${styleText(styles, "command", command[2])} ${styleText(styles, "loopId", command[3])}`;
    }

    if (line.trimStart().startsWith("…")) return styleText(styles, "muted", line);
    return line;
  }).join("\n");
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } =>
      typeof part === "object" &&
      part !== null &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
    )
    .map((part) => part.text)
    .join("\n");
}

export function buildResumableLoopsNotice(
  cwd: string,
  loops: RegistryEntry[],
  styles: ResumableLoopsNoticeStyle = {}
): string[] {
  const shown = loops.slice(0, 8);
  const status = [
    styleText(styles, "status", `${loops.length} active`),
    styleText(styles, "separator", "·"),
    styleText(styles, "status", "detached"),
  ].join(" ");
  const idColumnWidth = Math.min(
    48,
    Math.max(36, ...shown.map((loop) => `${loop.lane}/${loop.runTag}`.length + 8))
  );

  const lines = [
    `${styleText(styles, "rule", "━━")} ${styleText(styles, "title", "pi-multiloop")} ${styleText(styles, "rule", "━━━━━━━━━━━━━━━━━━━━━━━━━━━")} ${status} ${styleText(styles, "rule", "━━")}`,
    "",
  ];

  for (const loop of shown) {
    const id = `${loop.lane}/${loop.runTag}`;
    const state = loadState(cwd, { lane: loop.lane, runTag: loop.runTag });
    const mode = state?.mode ?? loop.mode;
    const iteration = state ? `${state.iteration} iter` : loop.status;
    const padding = " ".repeat(Math.max(2, idColumnWidth - id.length + 4));

    lines.push(
      `${styleText(styles, "arrow", " ·")} ${styleText(styles, "loopId", id)}${padding}${styleText(styles, "badge", `[ ${mode} ]`)} ${styleText(styles, "badge", `[ ${iteration} ]`)}`
    );

    if (state?.goal) {
      lines.push(`    ${styleText(styles, "goal", `"${truncateDisplay(state.goal, 64)}"`)}`);
    }
  }

  if (loops.length > shown.length) {
    lines.push(`  ${styleText(styles, "muted", `… ${loops.length - shown.length} more; run /multiloop ls`)}`);
  }

  lines.push(
    "",
    `${styleText(styles, "arrow", "❯")}  ${styleText(styles, "command", "/multiloop resume")} ${styleText(styles, "loopId", "<lane/run-tag>")}`,
    ""
  );
  return lines;
}

function resumableLoops(cwd: string): RegistryEntry[] {
  const attached = new Set(Array.from(activeStates.values()).map((s) => `${s.lane}/${s.runTag}`));
  return readRegistry(cwd).loops.filter(
    (loop) => loop.status === "active" && !attached.has(`${loop.lane}/${loop.runTag}`)
  );
}

function clearResumableLoopsWidget(ctx: ExtensionContext | ExtensionCommandContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget("multiloop-resume", undefined);
}

function announceResumableLoops(pi: ExtensionAPI, ctx: ExtensionContext): void {
  clearResumableLoopsWidget(ctx);
  if (!ctx.hasUI) return;

  const loops = resumableLoops(ctx.cwd);
  if (loops.length === 0) return;

  pi.sendMessage({
    customType: "multiloop-resume",
    content: buildResumableLoopsNotice(ctx.cwd, loops).join("\n"),
    display: true,
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerMessageRenderer("multiloop-resume", (message, _options, theme) =>
    new Text(colorizeResumableLoopsNotice(messageText(message.content), {
      fg: (name, text) => theme.fg(name as Parameters<typeof theme.fg>[0], text),
      bold: (text) => theme.bold(text),
    }), 0, 0)
  );

  pi.on("session_start", async (_event, ctx) => {
    announceResumableLoops(pi, ctx);
  });

  pi.on("input", async (event) => {
    lastInputAt = Date.now();
    if (event.source !== "extension") {
      if (shouldContinueAfterUserInput(event.text)) {
        markLoopTurn("user-query");
      } else {
        loopTurnActive = false;
        loopTurnReason = undefined;
      }
    }
  });

  pi.on("agent_start", async () => {
    agentRunning = true;
  });

  pi.on("session_before_compact", async (_event, ctx) => {
    pendingCompactionResumeTiming = decideCompactionResumeTiming({
      hasRunningStates: runningStates().length > 0 && loopTurnActive,
      agentRunning,
      isIdle: ctx.isIdle(),
      now: Date.now(),
      lastActiveAgentEndAt,
      lastInputAt,
    });
  });

  pi.on("session_compact", async (event, ctx) => {
    const timing = pendingCompactionResumeTiming ?? decideCompactionResumeTiming({
      hasRunningStates: runningStates().length > 0 && loopTurnActive,
      agentRunning,
      isIdle: ctx.isIdle(),
      now: Date.now(),
      lastActiveAgentEndAt,
      lastInputAt,
    });
    pendingCompactionResumeTiming = undefined;

    if (timing === "skip") return;

    if (timing === "after-current-agent-end") {
      resumeAfterCompact = true;
      lastCompactionEntryId = event.compactionEntry.id;
      return;
    }

    resumeAfterCompact = false;
    lastCompactionEntryId = undefined;
    queueCompactionResume(pi, ctx, event.compactionEntry.id);
  });

  pi.on("agent_end", async (_event, ctx) => {
    const endedLoopTurn = loopTurnActive;
    const endedLoopReason = loopTurnReason ?? "loop-turn";
    if (runningStates().length > 0 && endedLoopTurn) {
      lastActiveAgentEndAt = Date.now();
    }
    agentRunning = false;

    if (resumeAfterCompact) {
      const compactionEntryId = lastCompactionEntryId;
      resumeAfterCompact = false;
      lastCompactionEntryId = undefined;
      loopTurnActive = false;
      loopTurnReason = undefined;
      queueCompactionResume(pi, ctx, compactionEntryId);
      return;
    }

    loopTurnActive = false;
    loopTurnReason = undefined;

    if (endedLoopTurn) {
      queueLoopAutoContinue(pi, ctx, endedLoopReason);
    }
  });

  interface StartLoopConfig {
    lane: string;
    runTag?: string;
    mode: LoopMode;
    goal: string;
    verifyCommand: string;
    guardCommand?: string;
    promptVerifier?: string;
    acceptancePolicy?: string;
    metricName?: string;
    metricDirection?: "lower" | "higher";
    scope?: string;
  }

  function startLoop(ctx: ExtensionContext | ExtensionCommandContext, config: StartLoopConfig): LoopState {
    const id: LaneId = { lane: config.lane, runTag: config.runTag ?? generateRunTag() };
    const acceptancePolicy = config.acceptancePolicy
      ?? (config.guardCommand || config.promptVerifier
        ? "metric must improve and all mechanical/prompt verification checks must pass"
        : undefined);
    const state = createInitialState(id, config.mode, config.verifyCommand, {
      guardCommand: config.guardCommand,
      promptVerifier: config.promptVerifier,
      acceptancePolicy,
      metricName: config.metricName,
      metricDirection: config.metricDirection ?? MODES[config.mode].defaultDirection,
      scope: config.scope,
      goal: config.goal,
    });

    ensureLaneDir(ctx.cwd, id);
    saveState(ctx.cwd, id, state);

    const entry: RegistryEntry = {
      lane: id.lane,
      runTag: id.runTag,
      mode: config.mode,
      status: "active",
      startedAt: state.startedAt,
      stateDir: `.multiloop/active/${id.lane}/${id.runTag}`,
      verifyCommand: config.verifyCommand,
      guardCommand: config.guardCommand,
      promptVerifier: config.promptVerifier,
      acceptancePolicy,
      metric: config.metricName,
    };
    registerLoop(ctx.cwd, entry);

    activeStates.set(stateKey(id), state);
    updateStatus(ctx);
    return state;
  }

  function buildLoopStartPrompt(state: LoopState): string {
    return [
      `New ${state.mode} loop started: ${formatLaneId({ lane: state.lane, runTag: state.runTag })}`,
      `Verify: \`${state.verifyCommand}\``,
      state.guardCommand ? `Guard: \`${state.guardCommand}\`` : null,
      state.promptVerifier ? `Prompt verifier: ${state.promptVerifier}` : null,
      state.acceptancePolicy ? `Acceptance: ${state.acceptancePolicy}` : null,
      state.metricName ? `Metric: ${state.metricName} (${state.metricDirection})` : `Metric direction: ${state.metricDirection}`,
      state.scope ? `Scope: ${state.scope}` : null,
      `Goal: ${state.goal ?? ""}`,
      "",
      "Run the verify command to establish a baseline, call multiloop_measure to persist it, then keep iterating until the loop is stopped or paused.",
      "If asked a status/query while this loop remains running, answer briefly, then continue verify → measure → decide/log in state/results.",
    ].filter((line): line is string => line !== null).join("\n");
  }

  const StartParams = Type.Object({
    lane: Type.String({ description: "Lane identifier for this loop" }),
    mode: Type.Union([
      Type.Literal("optimize"),
      Type.Literal("punchlist"),
      Type.Literal("research"),
      Type.Literal("dev"),
    ], { description: "Loop mode selected by the setup guide" }),
    goal: Type.String({ description: "Confirmed user goal" }),
    verifyCommand: Type.String({ description: "Command that produces the primary metric" }),
    runTag: Type.Optional(Type.String({ description: "Run tag (auto-generated if omitted)" })),
    guardCommand: Type.Optional(Type.String({ description: "Optional pass/fail guard command" })),
    promptVerifier: Type.Optional(Type.String({ description: "Optional prompt-based correctness verifier / review criterion" })),
    acceptancePolicy: Type.Optional(Type.String({ description: "Acceptance rule, e.g. metric improves and all checks pass" })),
    metricName: Type.Optional(Type.String({ description: "Metric name" })),
    metricDirection: Type.Optional(Type.Union([Type.Literal("lower"), Type.Literal("higher")], { description: "Whether lower or higher metric values are better" })),
    scope: Type.Optional(Type.String({ description: "Files/directories in scope" })),
  });

  pi.registerTool({
    name: "multiloop_start",
    label: "Multiloop Start",
    description: "Start a new pi-multiloop after the setup guide has scanned the repo, asked clarifying questions, and received explicit user approval.",
    parameters: StartParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      markLoopTurn("multiloop_start");
      const state = startLoop(ctx, params as StartLoopConfig);
      return textResult(buildLoopStartPrompt(state));
    },
  });

  const IterateParams = Type.Object({
    lane: Type.String({ description: "Lane identifier (e.g., 'perf', 'quant')" }),
    runTag: Type.Optional(Type.String({ description: "Run tag (auto-generated if omitted)" })),
    hypothesis: Type.Optional(Type.String({ description: "What you're trying and why" })),
    changes: Type.Optional(Type.String({ description: "Summary of changes made" })),
  });

  pi.registerTool({
    name: "multiloop_iterate",
    label: "Multiloop Iterate",
    description: "Signal the start of a new loop iteration. Call this before making changes.",
    parameters: IterateParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      markLoopTurn("multiloop_iterate");
      const id: LaneId = { lane: params.lane, runTag: params.runTag ?? "" };

      let state: LoopState | undefined;
      for (const [_key, s] of activeStates.entries()) {
        if (s.lane === id.lane) {
          state = s;
          id.runTag = s.runTag;
          break;
        }
      }

      if (!state) {
        return textResult(`No active loop in lane "${id.lane}". Use /multiloop to start one.`);
      }

      if (shouldReanchor(state.iteration)) {
        const fresh = reanchor(ctx.cwd, id);
        if (fresh) {
          state = fresh;
          activeStates.set(stateKey(id), state);
        }
      }

      const nextIteration = state.iteration + 1;
      if (state.activeIteration?.phase === "measured") {
        return textResult(
          [
            `Iteration ${state.activeIteration.iteration} for ${formatLaneId(id)} is already measured.`,
            `Measurements: [${state.activeIteration.measurements?.join(", ") ?? ""}]`,
            `Call multiloop_decide with action="${state.activeIteration.recommendedAction ?? "log"}" before starting another iteration.`,
          ].join("\n")
        );
      }

      state.activeIteration = {
        iteration: state.activeIteration?.iteration ?? nextIteration,
        phase: "started",
        startedAt: state.activeIteration?.startedAt ?? new Date().toISOString(),
        hypothesis: params.hypothesis ?? state.activeIteration?.hypothesis,
        changes: params.changes ?? state.activeIteration?.changes,
      };
      saveState(ctx.cwd, id, state);
      activeStates.set(stateKey(id), state);

      return textResult(
        [
          `Iteration ${state.activeIteration.iteration} starting for ${formatLaneId(id)}.`,
          state.currentMetric !== null
            ? `Current ${state.metricName ?? "metric"}: ${state.currentMetric}`
            : `No baseline yet — this iteration will establish it.`,
          params.hypothesis ? `Hypothesis: ${params.hypothesis}` : "",
          `Run verify command: \`${state.verifyCommand}\``,
          state.guardCommand ? `Then run guard: \`${state.guardCommand}\`` : "",
          state.promptVerifier ? `Then run prompt verifier: ${state.promptVerifier}` : "",
          state.guardCommand || state.promptVerifier
            ? "Pass every mechanical/prompt check verdict to multiloop_measure.checks."
            : "",
        ]
          .filter(Boolean)
          .join("\n")
      );
    },
  });

  const VerificationCheckParams = Type.Object({
    name: Type.String({ description: "Check name, e.g. 'correctness', 'golden-output', or 'prompt-review'" }),
    passed: Type.Boolean({ description: "Whether this verification check passed" }),
    kind: Type.Optional(Type.String({ description: "Check kind: mechanical, prompt, guard, correctness, or other" })),
    command: Type.Optional(Type.String({ description: "Command that produced this check, for mechanical checks" })),
    prompt: Type.Optional(Type.String({ description: "Prompt/criterion used for prompt-based checks" })),
    evidence: Type.Optional(Type.String({ description: "Short evidence or summary supporting the verdict" })),
  });

  const MeasureParams = Type.Object({
    lane: Type.String({ description: "Lane identifier" }),
    measurements: Type.Array(Type.Number(), {
      description: "Array of metric measurements (run verify multiple times for confidence)",
    }),
    checks: Type.Optional(Type.Array(VerificationCheckParams, {
      description: "Optional mechanical/prompt verification checks. For compound verifiers, keep is recommended only when the metric improves and all checks pass.",
    })),
  });

  pi.registerTool({
    name: "multiloop_measure",
    label: "Multiloop Measure",
    description:
      "Record metric measurements and optional mechanical/prompt verification checks from the verify contract. Pass multiple measurements for statistical confidence.",
    parameters: MeasureParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      markLoopTurn("multiloop_measure");
      const id = findLane(params.lane);
      if (!id) {
        return textResult(`No active loop in lane "${params.lane}".`);
      }

      const state = activeStates.get(stateKey(id));
      if (!state) {
        return textResult(`No state for lane "${params.lane}".`);
      }

      const confidence = assessConfidence(params.measurements);
      const checks = ensureRequiredChecks(state, normalizeVerificationChecks(params.checks));

      if (state.baseline === null) {
        state.baseline = confidence.median;
        state.currentMetric = confidence.median;
        state.bestMetric = confidence.median;
        delete state.activeIteration;
        saveState(ctx.cwd, id, state);
        activeStates.set(stateKey(id), state);

        const lines = [
          `Baseline established for ${formatLaneId(id)}:`,
          `  ${state.metricName ?? "Metric"}: ${confidence.median}`,
          `  MAD: ${confidence.mad}`,
          `  Confidence: ${confidenceLabel(confidence.confidence)}`,
          `  Measurements: [${params.measurements.join(", ")}]`,
        ];
        if (checks.length > 0) {
          lines.push("  Verification checks:");
          lines.push(...formatVerificationChecks(checks));
          if (!checks.every((check) => check.passed)) {
            lines.push("  ⚠️ Baseline verification checks failed; fix the verifier/setup before optimizing.");
          }
        }
        lines.push("", "Baseline recorded. Start optimizing.");

        return textResult(lines.join("\n"));
      }

      const baseline = state.currentMetric ?? state.baseline;
      const improved = isImprovement(baseline, confidence.median, confidence.mad, state.metricDirection);
      const acceptance = assessAcceptance(state, improved, checks);
      const activeIteration = state.activeIteration ?? {
        iteration: state.iteration + 1,
        phase: "started" as const,
        startedAt: new Date().toISOString(),
      };
      state.activeIteration = {
        ...activeIteration,
        phase: "measured",
        measurements: confidence.measurements,
        metric: confidence.median,
        checks: acceptance.checks,
        acceptancePassed: acceptance.acceptancePassed,
        acceptanceReason: acceptance.acceptanceReason,
        recommendedAction: acceptance.recommendedAction,
        measuredAt: new Date().toISOString(),
      };
      saveState(ctx.cwd, id, state);
      activeStates.set(stateKey(id), state);

      const lines = [
        `Measurement for ${formatLaneId(id)}:`,
        `  ${state.metricName ?? "Metric"}: ${confidence.median}`,
        `  Baseline: ${baseline}`,
        `  Delta: ${formatDelta(baseline, confidence.median, state.metricDirection)}`,
        `  MAD: ${confidence.mad} | Confidence: ${confidenceLabel(confidence.confidence)}`,
        `  Improved: ${improved ? "YES" : "NO"}`,
      ];
      if (acceptance.checks.length > 0) {
        lines.push("  Verification checks:");
        lines.push(...formatVerificationChecks(acceptance.checks));
      }
      lines.push(
        `  Acceptance: ${acceptance.acceptancePassed ? "PASS" : "FAIL"} — ${acceptance.acceptanceReason}`,
        `  Recorded pending iteration: ${state.activeIteration.iteration}`,
        "",
        `Call multiloop_decide with action="${acceptance.recommendedAction}" to proceed.`
      );

      return textResult(lines.join("\n"));
    },
  });

  const DecideParams = Type.Object({
    lane: Type.String({ description: "Lane identifier" }),
    action: Type.Union(
      [Type.Literal("keep"), Type.Literal("revert"), Type.Literal("log"), Type.Literal("skip")],
      { description: "Decision: keep changes, revert, log only, or skip" }
    ),
    measurements: Type.Array(Type.Number(), {
      description: "Metric measurements for this iteration",
    }),
    hypothesis: Type.Optional(Type.String()),
    changes: Type.Optional(Type.String()),
  });

  pi.registerTool({
    name: "multiloop_decide",
    label: "Multiloop Decide",
    description:
      "Record the required keep/revert/log decision for the current measured iteration. Updates state and logs the result.",
    parameters: DecideParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      markLoopTurn("multiloop_decide");
      const id = findLane(params.lane);
      if (!id) {
        return textResult(`No active loop in lane "${params.lane}".`);
      }

      let state = activeStates.get(stateKey(id));
      if (!state) {
        return textResult(`No state for lane "${params.lane}".`);
      }

      if (state.currentMetric === null && state.baseline === null) {
        return textResult(`No baseline yet for lane "${params.lane}". Run multiloop_measure first.`);
      }

      if (state.activeIteration?.phase !== "measured") {
        return textResult(
          [
            `No measured iteration is pending for ${formatLaneId(id)}.`,
            "Run multiloop_iterate before changes, run the verify command, then call multiloop_measure before multiloop_decide.",
          ].join("\n")
        );
      }

      if (!sameMeasurements(state.activeIteration.measurements, params.measurements)) {
        return textResult(
          [
            `Measurement mismatch for ${formatLaneId(id)} iteration ${state.activeIteration.iteration}.`,
            `Recorded measurements: [${state.activeIteration.measurements?.join(", ") ?? ""}]`,
            `Provided measurements: [${params.measurements.join(", ")}]`,
            "Call multiloop_decide with the recorded measurements, or rerun verify and multiloop_measure to replace them.",
          ].join("\n")
        );
      }

      const recommendedAction = state.activeIteration.recommendedAction;
      if (recommendedAction && params.action !== recommendedAction) {
        return textResult(
          [
            `Decision mismatch for ${formatLaneId(id)} iteration ${state.activeIteration.iteration}.`,
            `Recorded acceptance: ${state.activeIteration.acceptancePassed === undefined ? "UNKNOWN" : state.activeIteration.acceptancePassed ? "PASS" : "FAIL"} — ${state.activeIteration.acceptanceReason ?? "no reason recorded"}`,
            `Recorded checks: ${state.activeIteration.checks?.length ? state.activeIteration.checks.map((check) => `${check.passed ? "PASS" : "FAIL"} ${check.name}`).join(", ") : "none"}`,
            `Required action from recorded verification: ${recommendedAction}`,
            "Call multiloop_decide with the required action, or rerun verify and multiloop_measure to replace the recorded verification.",
          ].join("\n")
        );
      }

      const confidence = assessConfidence(params.measurements);
      const baseline = state.currentMetric ?? state.baseline!;

      const acceptanceSuffix = state.activeIteration.acceptanceReason
        ? ` (${state.activeIteration.acceptanceReason})`
        : "";
      const decision = {
        action: params.action as "keep" | "revert" | "log" | "skip",
        reason: params.action === "keep"
          ? `Kept: ${formatDelta(baseline, confidence.median, state.metricDirection)}${acceptanceSuffix}`
          : params.action === "revert"
            ? `Reverted: ${formatDelta(baseline, confidence.median, state.metricDirection)}${acceptanceSuffix}`
            : `Logged: ${confidence.median}${acceptanceSuffix}`,
        shouldEscalate: false,
        escalationType: undefined as "refine" | "pivot" | "stop" | undefined,
      };

      if (params.action === "revert") {
        const esc = decide(state, confidence, baseline);
        const effectiveEscalation = esc.action === "revert"
          ? esc
          : failureEscalationDecision(state);
        decision.shouldEscalate = effectiveEscalation.shouldEscalate;
        decision.escalationType = effectiveEscalation.escalationType;
      }

      const decidedChecks = state.activeIteration.checks ?? [];
      const decidedAcceptancePassed = state.activeIteration.acceptancePassed;
      const decidedAcceptanceReason = state.activeIteration.acceptanceReason;

      state = applyDecision(
        ctx.cwd,
        id,
        state,
        decision,
        confidence,
        params.hypothesis ?? state.activeIteration.hypothesis,
        params.changes ?? state.activeIteration.changes
      );

      activeStates.set(stateKey(id), state);
      updateStatus(ctx);

      const lines = [
        `Iteration ${state.iteration} complete for ${formatLaneId(id)}:`,
        `  Action: ${params.action.toUpperCase()}`,
        `  ${state.metricName ?? "Metric"}: ${confidence.median}`,
        `  Consecutive failures: ${state.consecutiveFailures}`,
      ];
      if (decidedChecks.length > 0) {
        lines.push("  Verification checks:");
        lines.push(...formatVerificationChecks(decidedChecks));
      }
      if (decidedAcceptanceReason) {
        const decidedAcceptanceStatus = decidedAcceptancePassed === undefined
          ? "UNKNOWN"
          : decidedAcceptancePassed ? "PASS" : "FAIL";
        lines.push(`  Acceptance: ${decidedAcceptanceStatus} — ${decidedAcceptanceReason}`);
      }

      if (decision.shouldEscalate && decision.escalationType) {
        lines.push("");
        lines.push(buildEscalationPrompt(decision.escalationType, state));
      }

      if (state.status === "stopped") {
        lines.push("");
        lines.push("Loop has been stopped due to escalation exhaustion.");
        activeStates.delete(stateKey(id));
      } else {
        lines.push("");
        lines.push("Loop is still running; pi-multiloop will continue to the next required action automatically.");
      }

      return textResult(lines.join("\n"));
    },
  });

  const LogParams = Type.Object({
    lane: Type.String({ description: "Lane identifier" }),
    metric: Type.Optional(Type.Number({ description: "Metric value to log" })),
    note: Type.Optional(Type.String({ description: "Free-text note for this iteration" })),
  });

  pi.registerTool({
    name: "multiloop_log",
    label: "Multiloop Log",
    description: "Log an iteration result without keep/revert semantics. For research and dev modes.",
    parameters: LogParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      markLoopTurn("multiloop_log");
      const id = findLane(params.lane);
      if (!id) {
        return textResult(`No active loop in lane "${params.lane}".`);
      }

      const state = activeStates.get(stateKey(id));
      if (!state) {
        return textResult(`No state for lane "${params.lane}".`);
      }

      const activeIteration = state.activeIteration;
      const metric = params.metric ?? activeIteration?.metric;
      appendResult(ctx.cwd, id, {
        iteration: state.iteration + 1,
        timestamp: new Date().toISOString(),
        action: "log",
        metric,
        hypothesis: params.note ?? activeIteration?.hypothesis,
        measurements: activeIteration?.measurements,
        checks: activeIteration?.checks,
        acceptancePassed: activeIteration?.acceptancePassed,
        acceptanceReason: activeIteration?.acceptanceReason,
      });

      state.iteration++;
      delete state.activeIteration;
      if (metric !== undefined) {
        state.currentMetric = metric;
      }
      saveState(ctx.cwd, id, state);
      activeStates.set(stateKey(id), state);
      updateStatus(ctx);

      const lines = [`Logged iteration ${state.iteration} for ${formatLaneId(id)}.${metric !== undefined ? ` Metric: ${metric}` : ""}`];
      if (activeIteration?.checks?.length) {
        lines.push("Verification checks:");
        lines.push(...formatVerificationChecks(activeIteration.checks));
      }
      if (activeIteration?.acceptanceReason) {
        const acceptanceStatus = activeIteration.acceptancePassed === undefined
          ? "UNKNOWN"
          : activeIteration.acceptancePassed ? "PASS" : "FAIL";
        lines.push(`Acceptance: ${acceptanceStatus} — ${activeIteration.acceptanceReason}`);
      }
      lines.push("Loop is still running; pi-multiloop will continue to the next required action automatically.");

      return textResult(lines.join("\n"));
    },
  });

  function showStatus(ctx: ExtensionCommandContext) {
    if (activeStates.size === 0) {
      const registry = readRegistry(ctx.cwd);
      if (registry.loops.length === 0) {
        pi.sendMessage({
          customType: "multiloop-status",
          content: "No active loops.",
          display: true,
        });
      } else {
        const lines = registry.loops.map(
          (l) => `  ${loopSummary(ctx.cwd, l)} [${l.status}]`
        );
        pi.sendMessage({
          customType: "multiloop-status",
          content: `No active loops. Registry has ${registry.loops.length} entries:\n${lines.join("\n")}`,
          display: true,
        });
      }
      return;
    }

    const lines: string[] = [];
    for (const state of activeStates.values()) {
      lines.push(buildIterationContext(state));
      lines.push("");
    }

    pi.sendMessage({
      customType: "multiloop-status",
      content: lines.join("\n"),
      display: true,
    });
  }

  async function archiveHandler(args: string, ctx: ExtensionCommandContext) {
    const trimmed = args.trim();

    if (trimmed) {
      const id = parseLaneId(trimmed);
      if (!id) {
        ctx.ui.notify(`Invalid lane/run-tag: "${trimmed}". Format: lane/run-tag`, "error");
        return;
      }
      const loop = getLoop(ctx.cwd, id);
      if (!loop) {
        ctx.ui.notify(`No loop found: ${formatLaneId(id)}`, "error");
        return;
      }
      const summary = loopSummary(ctx.cwd, loop);
      archiveLaneDirs(ctx.cwd, id);
      activeStates.delete(stateKey(id));
      updateStatus(ctx);
      ctx.ui.notify(`Archived ${summary}`, "info");
      return;
    }

    const registry = readRegistry(ctx.cwd);
    if (registry.loops.length === 0) {
      ctx.ui.notify("No loops to archive.", "info");
      return;
    }

    const archivable = registry.loops.filter(
      (l) => l.status !== "archived"
    );
    const inMemory = new Set(
      Array.from(activeStates.values()).map((s) => `${s.lane}/${s.runTag}`)
    );
    const toArchive = archivable.filter(
      (l) => l.status === "completed" || l.status === "paused" || !inMemory.has(`${l.lane}/${l.runTag}`)
    );

    const lines: string[] = [];

    if (toArchive.length > 0) {
      for (const loop of toArchive) {
        const id: LaneId = { lane: loop.lane, runTag: loop.runTag };
        const summary = loopSummary(ctx.cwd, loop);
        try {
          archiveLaneDirs(ctx.cwd, id);
          activeStates.delete(stateKey(id));
          lines.push(`  archived: ${summary}`);
        } catch {
          lines.push(`  skipped: ${summary} (state dir missing)`);
          activeStates.delete(stateKey(id));
          updateLoopStatus(ctx.cwd, id, "archived", "");
        }
      }
    } else {
      lines.push("  No loops to archive.");
    }

    const stillActive = archivable.filter(
      (l) => l.status === "active" && inMemory.has(`${l.lane}/${l.runTag}`)
    );
    if (stillActive.length > 0) {
      lines.push("");
      lines.push("Still active (in current session):");
      for (const loop of stillActive) {
        lines.push(`  * ${loopSummary(ctx.cwd, loop)}`);
      }
    }

    updateStatus(ctx);
    pi.sendMessage({
      customType: "multiloop-archive",
      content: lines.join("\n"),
      display: true,
    });
  }

  pi.registerCommand("multiloop", {
    description: "Start, resume, or manage autonomous iteration loops",
    async handler(args, ctx) {
      const trimmed = args.trim();

      if (trimmed.startsWith("resume")) {
        const idStr = trimmed.replace(/^resume\s*/, "").trim();
        const id = parseLaneId(idStr);
        if (!id) {
          ctx.ui.notify(`Invalid lane/run-tag: "${idStr}". Format: lane/run-tag`, "error");
          return;
        }
        const state = reconstructState(ctx.cwd, id);
        if (!state) {
          ctx.ui.notify(`No state found for ${formatLaneId(id)}`, "error");
          return;
        }
        state.status = "running";
        saveState(ctx.cwd, id, state);
        activeStates.set(stateKey(id), state);
        updateLoopStatus(ctx.cwd, id, "active");
        updateStatus(ctx);
        ctx.ui.notify(`Resumed loop ${formatLaneId(id)} at iteration ${state.iteration}`, "info");
        markLoopTurn("explicit-resume");
        pi.sendUserMessage(buildExplicitResumePrompt([state]), { deliverAs: "followUp" });
        return;
      }

      if (trimmed === "stop" || trimmed.startsWith("stop ")) {
        const laneName = trimmed.replace(/^stop\s*/, "").trim();
        let stopped = false;

        for (const [key, state] of activeStates.entries()) {
          if (!laneName || state.lane === laneName) {
            const id: LaneId = { lane: state.lane, runTag: state.runTag };
            state.status = "stopped";
            saveState(ctx.cwd, id, state);
            updateLoopStatus(ctx.cwd, id, "completed");
            activeStates.delete(key);
            ctx.ui.notify(`Stopped loop ${formatLaneId(id)}`, "info");
            stopped = true;
          }
        }

        if (!stopped) {
          const registry = readRegistry(ctx.cwd);
          for (const entry of registry.loops) {
            if (entry.status === "active" && (!laneName || entry.lane === laneName)) {
              const id: LaneId = { lane: entry.lane, runTag: entry.runTag };
              updateLoopStatus(ctx.cwd, id, "completed");
              const state = reconstructState(ctx.cwd, id);
              if (state) {
                state.status = "stopped";
                saveState(ctx.cwd, id, state);
              }
              ctx.ui.notify(`Stopped loop ${formatLaneId(id)}`, "info");
              stopped = true;
            }
          }
        }

        if (!stopped) {
          ctx.ui.notify(laneName ? `No active loop in lane "${laneName}".` : "No active loops to stop.", "info");
        }

        updateStatus(ctx);
        return;
      }

      if (trimmed === "pause" || trimmed.startsWith("pause ")) {
        const laneName = trimmed.replace(/^pause\s*/, "").trim();
        let paused = false;

        for (const [key, state] of activeStates.entries()) {
          if (!laneName || state.lane === laneName) {
            const id: LaneId = { lane: state.lane, runTag: state.runTag };
            state.status = "paused";
            saveState(ctx.cwd, id, state);
            updateLoopStatus(ctx.cwd, id, "paused");
            activeStates.delete(key);
            ctx.ui.notify(`Paused loop ${formatLaneId(id)}`, "info");
            paused = true;
          }
        }

        if (!paused) {
          const registry = readRegistry(ctx.cwd);
          for (const entry of registry.loops) {
            if (entry.status === "active" && (!laneName || entry.lane === laneName)) {
              const id: LaneId = { lane: entry.lane, runTag: entry.runTag };
              updateLoopStatus(ctx.cwd, id, "paused");
              const state = reconstructState(ctx.cwd, id);
              if (state) {
                state.status = "paused";
                saveState(ctx.cwd, id, state);
              }
              ctx.ui.notify(`Paused loop ${formatLaneId(id)}`, "info");
              paused = true;
            }
          }
        }

        if (!paused) {
          ctx.ui.notify(laneName ? `No active loop in lane "${laneName}".` : "No active loops to pause.", "info");
        }

        updateStatus(ctx);
        return;
      }

      if (trimmed === "list" || trimmed === "ls") {
        const registry = readRegistry(ctx.cwd);
        if (registry.loops.length === 0) {
          ctx.ui.notify("No loops registered.", "info");
          return;
        }
        const lines = registry.loops.map(
          (l) =>
            `${l.status === "active" ? "*" : " "} ${loopSummary(ctx.cwd, l)} [${l.status}]`
        );
        pi.sendMessage({
          customType: "multiloop-list",
          content: lines.join("\n"),
          display: true,
        });
        return;
      }

      if (trimmed === "status") {
        showStatus(ctx);
        return;
      }

      if (trimmed === "archive" || trimmed.startsWith("archive ")) {
        const archiveArgs = trimmed.replace(/^archive\s*/, "").trim();
        await archiveHandler(archiveArgs, ctx);
        return;
      }

      if (trimmed.startsWith("rm ")) {
        const idStr = trimmed.replace(/^rm\s*/, "").trim();
        const id = parseLaneId(idStr);
        if (!id) {
          ctx.ui.notify(`Invalid lane/run-tag: "${idStr}". Format: lane/run-tag`, "error");
          return;
        }
        const loop = getLoop(ctx.cwd, id);
        if (!loop) {
          ctx.ui.notify(`No loop found: ${formatLaneId(id)}`, "error");
          return;
        }
        const summary = loopSummary(ctx.cwd, loop);
        activeStates.delete(stateKey(id));
        deleteLaneDirs(ctx.cwd, id);
        updateStatus(ctx);
        ctx.ui.notify(`Deleted ${summary}`, "info");
        return;
      }

      if (!trimmed || trimmed === "guide" || trimmed === "wizard" || trimmed === "setup") {
        pi.sendUserMessage(buildSetupGuidePrompt(), { deliverAs: "followUp" });
        return;
      }

      if (trimmed === "help") {
        pi.sendMessage({
          customType: "multiloop-help",
          content: [
            "pi-multiloop — run autonomous iteration loops with isolated state per lane.",
            "",
            "Modes:",
            "  optimize    Edit, measure, keep/revert. For performance tuning and benchmarks.",
            "  research    Measure and log without keep/revert. For ablations and sweeps.",
            "  dev         Implement, test, commit. General development with tracking.",
            "  punchlist   Work through a checklist until all items pass.",
            "",
            "Commands:",
            "  status           Show active loops",
            "  ls               List all loops in registry",
            "  stop [lane]      Stop active loop(s)",
            "  pause [lane]     Pause active loop(s)",
            "  guide            Launch the setup guide for a new high-quality loop",
            "  resume <id>      Resume a stopped/paused loop",
            "  archive [id]     Archive completed loops (all by default)",
            "  rm <id>          Delete a loop and its state files",
            "  help             Show this help",
            "",
            "To start a new loop, just describe your goal after /multiloop. For example:",
            '  /multiloop improve inference latency, verify: `./bench.py --quick`',
            '  /multiloop improve speed safely, verify: `./bench.py`, guard: `npm test`, prompt verifier: `Check output semantics against fixtures.`',
            "",
            "If you need help setting one up, just ask — describe what you want to",
            "optimize, research, or build and the agent will configure the loop for you.",
          ].join("\n"),
          display: true,
        });
        return;
      }

      const mode = detectMode(trimmed);
      const laneParts = trimmed.match(/lane[:\s]+(\w+)/i);
      const lane = laneParts?.[1] ?? mode;
      const verifyCommand = extractQuotedOption(trimmed, ["verify"]) ?? "echo 'TODO: set verify command'";
      const guardCommand = extractQuotedOption(trimmed, ["guard", "correctness", "correctness command"]);
      const promptVerifier = extractQuotedOption(trimmed, [
        "prompt verifier",
        "prompt-verifier",
        "verifier prompt",
        "prompt check",
        "prompt-check",
        "correctness prompt",
      ]);
      const acceptancePolicy = extractQuotedOption(trimmed, ["acceptance", "acceptance policy", "accept"]);

      const state = startLoop(ctx, {
        lane,
        mode,
        goal: trimmed,
        verifyCommand,
        guardCommand,
        promptVerifier,
        acceptancePolicy,
        metricDirection: MODES[mode].defaultDirection,
      });

      markLoopTurn("start");
      pi.sendUserMessage(buildLoopStartPrompt(state), { deliverAs: "steer" });
    },
  });

  function findLane(laneName: string): LaneId | null {
    for (const state of activeStates.values()) {
      if (state.lane === laneName) {
        return { lane: state.lane, runTag: state.runTag };
      }
    }
    const id = parseLaneId(laneName);
    if (id && activeStates.has(stateKey(id))) return id;
    return null;
  }

  function updateStatus(ctx: ExtensionContext | ExtensionCommandContext) {
    if (activeStates.size > 0) {
      const summaries = Array.from(activeStates.values()).map(
        (s) => `${s.lane}#${s.iteration}`
      );
      ctx.ui.setStatus("multiloop", `multiloop: ${summaries.join(", ")}`);
    } else {
      ctx.ui.setStatus("multiloop", undefined);
    }

    clearResumableLoopsWidget(ctx);
  }
}
