import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
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
  resolveLoopTarget,
  type TargetResolution,
  archiveLoop as archiveLaneDirs,
  deleteLaneDirs,
  readRegistry,
} from "./lanes.js";
import {
  type LoopState,
  type RunAccounting,
  accountedTokens,
  emptyAccounting,
  isQuickGoal,
  readAccounting,
  createInitialState,
  saveState,
  loadState,
  reconstructState,
  appendResult,
  recordActionCounter,
  formatActionCounters,
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
import { MODES, type LoopMode } from "./modes.js";
import {
  discoverTasksStore,
  formatTaskListSnapshot,
  readTaskSnapshot,
  type TaskSnapshot,
} from "./tasks.js";
import {
  buildQuickGoalContinuationPrompt,
  buildQuickGoalStartPrompt,
  deriveGoalMode,
  deriveLane,
  parseGoalCommand,
  validateObjective,
} from "./goal.js";
import {
  assessAcceptance,
  ensureRequiredChecks,
  formatVerificationChecks,
  normalizeVerificationChecks,
} from "./verifiers.js";

const activeStates = new Map<string, LoopState>();
let agentRunning = false;
let resumeAfterCompact = false;
let lastCompactionEntryId: string | undefined;
let pendingCompactionResumeTiming: CompactionResumeTiming | undefined;
let lastActiveAgentEndAt = 0;
let lastInputAt = 0;
let loopTurnActive = false;
let loopTurnReason: string | undefined;
let turnStartedAt = 0;
let toolCallsThisTurn = 0;
let toolCallsSinceContinuation = 0;
let continuationsQueued = 0;

/**
 * Accounting is attributed to every run that was active during the turn. With
 * one run — the common case — that is exact; with several concurrent lanes each
 * run records the work performed while it was active rather than an
 * unattributable share of it. Nothing here reaches the model.
 */
function accountTurn(
  ctx: ExtensionContext,
  usage: { input: number; output: number },
  elapsedSeconds: number,
  toolCalls: number
): void {
  for (const state of activeStates.values()) {
    if (state.status !== "running") continue;
    const accounting = readAccounting(state);
    accounting.activeSeconds += elapsedSeconds;
    accounting.turns += 1;
    accounting.toolCalls += toolCalls;
    accounting.inputTokens += usage.input;
    accounting.outputTokens += usage.output;
    state.accounting = accounting;
    saveState(ctx.cwd, { lane: state.lane, runTag: state.runTag }, state);
  }
}

function collectAssistantUsage(messages: unknown[]): { input: number; output: number } {
  let input = 0;
  let output = 0;
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    const record = message as Record<string, unknown>;
    if (record.role !== "assistant") continue;
    const usage = record.usage;
    if (typeof usage !== "object" || usage === null) continue;
    const fields = usage as Record<string, unknown>;
    input += numericField(fields.input);
    output += numericField(fields.output);
  }
  return { input, output };
}

function numericField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.trunc(totalSeconds));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.trunc(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.trunc(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours >= 24) return `${Math.trunc(hours / 24)}d ${hours % 24}h ${remainingMinutes}m`;
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}

export function formatTokenCount(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${trimDecimal(value / 1_000_000)}M`;
  if (abs >= 1_000) return `${trimDecimal(value / 1_000)}K`;
  return String(Math.trunc(value));
}

function trimDecimal(value: number): string {
  const rounded = value.toFixed(1);
  return rounded.endsWith(".0") ? rounded.slice(0, -2) : rounded;
}

/**
 * One-line work summary for the user. Callers must not put this in a prompt.
 */
export function formatAccounting(accounting: RunAccounting, tokenBudget?: number): string {
  const tokens = accountedTokens(accounting);
  const budget = tokenBudget === undefined ? "" : ` of ${formatTokenCount(tokenBudget)}`;
  return [
    `time ${formatDuration(accounting.activeSeconds)}`,
    `${accounting.turns} turn${accounting.turns === 1 ? "" : "s"}`,
    `${accounting.toolCalls} tool call${accounting.toolCalls === 1 ? "" : "s"}`,
    `${formatTokenCount(tokens)}${budget} tokens`,
  ].join(", ");
}

/** Live pi-tasks state for this session, or null when there is no store. */
function taskSnapshotFor(ctx: ExtensionContext): TaskSnapshot | null {
  try {
    const discovery = discoverTasksStore(ctx.cwd, ctx.sessionManager.getSessionId());
    return readTaskSnapshot(discovery.storePath);
  } catch {
    return null;
  }
}

/**
 * pi-tasks drives the next turn itself when its automatic mode is on and it has
 * already queued work. Stand down so the two do not both continue.
 */
function cascadingTasksWillDrive(ctx: ExtensionContext): boolean {
  try {
    const discovery = discoverTasksStore(ctx.cwd, ctx.sessionManager.getSessionId());
    if (discovery.autoMode === "off") return false;
    return ctx.hasPendingMessages();
  } catch {
    return false;
  }
}

/** True once a budgeted run has spent its cap. */
export function budgetExhausted(state: LoopState): boolean {
  if (state.tokenBudget === undefined) return false;
  return accountedTokens(readAccounting(state)) >= state.tokenBudget;
}

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
  if (isQuickGoal(state)) {
    return `- ${state.lane}/${state.runTag}: continue the quick goal. Do the next concrete action toward the objective, record finished steps with multiloop_log, and call update_goal with status "complete" only after the completion audit passes.`;
  }

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

/** Pi reports why a compaction ran; earlier releases did not. */
export type CompactionReason = "manual" | "threshold" | "overflow" | undefined;

export interface CompactionResumeTimingInput {
  hasRunningStates: boolean;
  agentRunning: boolean;
  reason: CompactionReason;
  willRetry: boolean;
}

export function compactionReason(event: unknown): CompactionReason {
  const reason = (event as { reason?: unknown } | null)?.reason;
  return reason === "manual" || reason === "threshold" || reason === "overflow" ? reason : undefined;
}

export function compactionWillRetry(event: unknown): boolean {
  return (event as { willRetry?: unknown } | null)?.willRetry === true;
}

/**
 * Decide whether a compaction should be followed by a loop resume.
 *
 * Pi supplies `reason` and `willRetry` on its compaction events, so this reads
 * the reported cause directly. It replaces the timing window used through
 * 0.3.3, which inferred the cause from how recently a turn or keystroke
 * happened and misread slow turns and fast typing alike.
 */
export function decideCompactionResumeTiming(input: CompactionResumeTimingInput): CompactionResumeTiming {
  if (!input.hasRunningStates) return "skip";

  // Overflow recovery re-runs the aborted turn itself; a resume would duplicate it.
  if (input.willRetry) return "skip";

  // A user typing /compact while work is idle is asking to compact, not to
  // restart the loop.
  if (input.reason === "manual" && !input.agentRunning) return "skip";

  if (input.agentRunning) return "after-current-agent-end";
  return "after-compaction";
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
      continuationsQueued += 1;
      toolCallsSinceContinuation = 0;
      pi.sendUserMessage(buildAutoContinuePrompt(latestStates, taskSnapshotFor(ctx)), { deliverAs: "followUp" });
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

export function buildAutoContinuePrompt(states: LoopState[], taskSnapshot?: TaskSnapshot | null): string {
  // A quick goal has no verify/measure/decide cycle to continue into, so it
  // gets the objective and completion audit rather than loop mechanics.
  if (states.length === 1 && states[0] && isQuickGoal(states[0])) {
    const goal = states[0];
    return buildQuickGoalContinuationPrompt({
      lane: goal.lane,
      runTag: goal.runTag,
      objective: goal.goal ?? "",
      taskSnapshot: taskSnapshot ? formatTaskListSnapshot(taskSnapshot) : null,
      hasOpenTasks: (taskSnapshot?.open.length ?? 0) > 0,
    });
  }

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

export function buildLoopStartPrompt(state: LoopState): string {
  // A run with no verify command has no baseline to establish and no metric
  // to measure, so it must not be told to run one.
  const measured = Boolean(state.verifyCommand);
  return [
    `New ${state.mode} loop started: ${formatLaneId({ lane: state.lane, runTag: state.runTag })}`,
    state.verifyCommand ? `Verify: \`${state.verifyCommand}\`` : "No verify command: this run has no metric.",
    state.guardCommand ? `Guard: \`${state.guardCommand}\`` : null,
    state.promptVerifier ? `Prompt verifier: ${state.promptVerifier}` : null,
    state.acceptancePolicy ? `Acceptance: ${state.acceptancePolicy}` : null,
    state.metricName
      ? `Metric: ${state.metricName} (${state.metricDirection})`
      : measured ? `Metric direction: ${state.metricDirection}` : null,
    `Acceptance mode: ${state.acceptanceMode}`,
    state.scope ? `Scope: ${state.scope}` : null,
    `Goal: ${state.goal ?? ""}`,
    "",
    measured
      ? "Run the verify command to establish a baseline, call multiloop_measure to persist it, then keep iterating until the loop is stopped or paused."
      : "Do the next concrete action toward the goal and record each finished step with multiloop_log. Keep working until the run is stopped or paused, or until the goal is achieved.",
    measured
      ? "If asked a status/query while this loop remains running, answer briefly, then continue verify → measure → decide/log in state/results."
      : "If asked a status/query while this run remains running, answer briefly, then continue the work.",
  ].filter((line): line is string => line !== null).join("\n");
}

export function buildSetupGuidePrompt(goalSeed?: string): string {
  return [
    "Set up a pi-multiloop measured run and get it started with one approval.",
    goalSeed?.trim() ? `User goal seed: ${goalSeed.trim()}` : undefined,
    "",
    "Setup contract (the canonical version lives with the multiloop skill at `references/LOOP_GUIDE.md`):",
    "1. Scan the repo before proposing anything: structure, manifests/scripts/configs, tests/benches, and relevant TODO/plan files. Do not edit files during setup.",
    "2. Propose the whole configuration in one message: goal, mode, lane, scope, metric name and direction, acceptance mode, verify command, guard command, prompt verifier, acceptance policy, stop condition, and rollback safety. Mark every value you derived rather than were told, so the user can correct it in one reply.",
    "3. Ask a clarification round only when one of these is true: the scan found no command that produces a metric; more than one plausible metric source exists and picking wrong would waste the run; or a proposed command is destructive or otherwise unsafe. Otherwise do not ask questions — propose defaults and let the user correct them.",
    "4. Wait for one approval. Any reply that accepts or corrects the proposal is the approval; only a question or a refusal is not.",
    "5. After approval, call multiloop_start with the confirmed config and continue autonomously until stopped, paused, completed, or blocked. Do not ask another question unless a true safety blocker appears.",
    "6. For punchlists, default to acceptanceMode=log with open_or_partial_items lower-is-better progress; use keep-revert only when the user confirms a metric optimization goal plus rollback safety.",
    "7. For compound goals such as performance improves while output remains correct, configure a metric verify command plus mechanical/prompt checks. Acceptance is: metric improves and every check passes.",
    "",
    "If the request needs no metric and no verify command, it is a quick goal, not a measured run: tell the user to run /goal <objective> instead, which starts immediately with no setup.",
    "",
    "Proposal format:",
    "**Proposed loop**",
    "- Target: ...",
    "- Metric: ... (direction: lower/higher; acceptance mode: log/keep-revert)",
    "- Verify: `...`",
    "- Guard/checks: `...` plus prompt verifier if needed",
    "- Scope/lane: ...",
    "- Stop condition: ...",
    "",
    "**Next step**",
    "- Reply go to start, or tell me what to change.",
  ].filter((line): line is string => line !== undefined).join("\n");
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
    details.push(formatActionCounters(state));
  }
  if (state != null && state.baseline !== null && state.bestMetric !== null && state.baseline !== state.bestMetric) {
    details.push(`${state.baseline} → ${state.bestMetric}`);
  }
  parts.push(`(${details.join(", ")})`);

  return parts.join(" — ");
}

function sortedLoops(loops: RegistryEntry[]): RegistryEntry[] {
  return [...loops].sort((a, b) => {
    const bTime = Date.parse(b.startedAt) || 0;
    const aTime = Date.parse(a.startedAt) || 0;
    if (bTime !== aTime) return bTime - aTime;
    return `${a.lane}/${a.runTag}`.localeCompare(`${b.lane}/${b.runTag}`);
  });
}

function formatLoopLine(cwd: string, loop: RegistryEntry, prefix = "  - "): string {
  return `${prefix}${loopSummary(cwd, loop)} [${loop.status}]`;
}

export function formatLoopList(
  cwd: string,
  loops: RegistryEntry[],
  options: { includeArchived?: boolean } = {}
): string {
  const includeArchived = options.includeArchived ?? false;
  const visible = sortedLoops(loops).filter((loop) => includeArchived || loop.status !== "archived");
  const archivedHidden = includeArchived ? 0 : loops.filter((loop) => loop.status === "archived").length;

  if (visible.length === 0) {
    return archivedHidden > 0
      ? `No non-archived loops. ${archivedHidden} archived loop${archivedHidden === 1 ? " is" : "s are"} hidden; run /multiloop ls --archived to include archived runs.`
      : "No loops registered.";
  }

  const order: RegistryEntry["status"][] = ["active", "paused", "completed", "archived"];
  const titles: Record<RegistryEntry["status"], string> = {
    active: "Active / resumable",
    paused: "Paused",
    completed: "Completed / stopped",
    archived: "Archived",
  };
  const lines: string[] = [];

  for (const status of order) {
    const group = visible.filter((loop) => loop.status === status);
    if (group.length === 0) continue;
    if (lines.length > 0) lines.push("");
    lines.push(`${titles[status]}:`);
    lines.push(...group.map((loop) => formatLoopLine(cwd, loop)));
  }

  if (archivedHidden > 0) {
    lines.push("", `${archivedHidden} archived loop${archivedHidden === 1 ? " is" : "s are"} hidden; run /multiloop ls --archived to include archived runs.`);
  }

  return lines.join("\n");
}

export function formatLoopStatusOverview(
  cwd: string,
  loops: RegistryEntry[],
  states: LoopState[]
): string {
  const attachedKeys = new Set(states.map((state) => `${state.lane}/${state.runTag}`));
  const attachedRunning = states.filter((state) => state.status === "running");
  const detachedResumable = sortedLoops(loops).filter(
    (loop) => loop.status === "active" && !attachedKeys.has(`${loop.lane}/${loop.runTag}`)
  );
  const inactive = sortedLoops(loops).filter((loop) => loop.status === "paused" || loop.status === "completed");
  const archivedCount = loops.filter((loop) => loop.status === "archived").length;
  const lines: string[] = ["pi-multiloop status"];

  if (attachedRunning.length > 0) {
    lines.push("", "Attached running loops:");
    for (const state of attachedRunning) {
      const kind = isQuickGoal(state) ? "goal" : state.mode;
      lines.push(`  - ${state.lane}/${state.runTag} (${kind}, ${state.iteration} iter, ${formatActionCounters(state)})`);
      if (state.goal) lines.push(`    ${truncateDisplay(state.goal, 80)}`);
      lines.push(`    ${formatAccounting(readAccounting(state), state.tokenBudget)}`);
    }
  }

  if (detachedResumable.length > 0) {
    lines.push("", "Detached resumable loops:");
    lines.push(...detachedResumable.map((loop) => formatLoopLine(cwd, loop)));
  }

  if (inactive.length > 0) {
    lines.push("", "Inactive/history:");
    lines.push(...inactive.map((loop) => formatLoopLine(cwd, loop)));
  }

  if (archivedCount > 0) {
    lines.push("", `Archived: ${archivedCount} run${archivedCount === 1 ? "" : "s"} hidden from the default view; run /multiloop ls --archived.`);
  }

  if (lines.length === 1) {
    lines.push("", "No existing multiloop state. Run /multiloop guide to create one.");
  }

  return lines.join("\n");
}

function registrySnapshot(loops: RegistryEntry[]): string {
  if (loops.length === 0) return "  (registry is empty)";
  return sortedLoops(loops)
    .map((loop) => `  - ${loop.lane}/${loop.runTag} [${loop.status}] mode=${loop.mode} started=${loop.startedAt || "unknown"}`)
    .join("\n");
}

export function buildTargetDisambiguationPrompt(
  operation: "resume" | "pause" | "stop" | "archive",
  target: string,
  resolution: TargetResolution,
  loops: RegistryEntry[]
): string {
  const toolName = `multiloop_${operation}`;
  return [
    `Resolve a pi-multiloop ${operation} request.`,
    `Requested target: ${target.trim() || "(empty)"}`,
    `Resolver result: ${resolution.status}${"message" in resolution ? ` — ${resolution.message}` : ""}`,
    "",
    "Registry snapshot:",
    registrySnapshot(loops),
    "",
    `If the intended loop is clear, call ${toolName} with the exact lane/run-tag target. If it is ambiguous or unsafe, ask the user to choose an exact lane/run-tag. Do not start a new loop.`,
  ].join("\n");
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
    turnStartedAt = Date.now();
    toolCallsThisTurn = 0;
  });

  pi.on("tool_call", async () => {
    toolCallsThisTurn += 1;
    toolCallsSinceContinuation += 1;
  });

  pi.on("session_before_compact", async (event, _ctx) => {
    pendingCompactionResumeTiming = decideCompactionResumeTiming({
      hasRunningStates: runningStates().length > 0 && loopTurnActive,
      agentRunning,
      reason: compactionReason(event),
      willRetry: compactionWillRetry(event),
    });
  });

  pi.on("session_compact", async (event, ctx) => {
    const timing = pendingCompactionResumeTiming ?? decideCompactionResumeTiming({
      hasRunningStates: runningStates().length > 0 && loopTurnActive,
      agentRunning,
      reason: compactionReason(event),
      willRetry: compactionWillRetry(event),
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

  pi.on("agent_end", async (event, ctx) => {
    const endedLoopTurn = loopTurnActive;
    const endedLoopReason = loopTurnReason ?? "loop-turn";
    if (runningStates().length > 0 && endedLoopTurn) {
      lastActiveAgentEndAt = Date.now();
    }
    agentRunning = false;

    const elapsedSeconds = turnStartedAt > 0 ? Math.round((Date.now() - turnStartedAt) / 1000) : 0;
    turnStartedAt = 0;
    const turnToolCalls = toolCallsThisTurn;
    toolCallsThisTurn = 0;
    accountTurn(ctx, collectAssistantUsage(event.messages ?? []), elapsedSeconds, turnToolCalls);

    for (const state of runningStates()) {
      if (!budgetExhausted(state)) continue;
      const id: LaneId = { lane: state.lane, runTag: state.runTag };
      pauseLoop(ctx, id);
      ctx.ui.notify(
        [
          `Paused ${formatLaneId(id)}: token budget reached.`,
          `  ${formatAccounting(readAccounting(state), state.tokenBudget)}`,
          `  Raise or clear it with /goal tokens <N|off>, then /multiloop resume ${formatLaneId(id)}.`,
        ].join("\n"),
        "warning"
      );
    }

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

    if (!endedLoopTurn) return;

    // pi-tasks drives the next turn when its automatic mode already queued
    // work; two continuations for one turn would duplicate it.
    if (cascadingTasksWillDrive(ctx)) return;

    // A continuation that produced no tool calls is not making progress.
    // Pause rather than spend another turn on the same prompt.
    if (continuationsQueued > 0 && toolCallsSinceContinuation === 0) {
      continuationsQueued = 0;
      const stalled = runningStates();
      for (const state of stalled) {
        pauseLoop(ctx, { lane: state.lane, runTag: state.runTag });
      }
      if (stalled.length > 0) {
        ctx.ui.notify(
          `Paused ${stalled.map((state) => `${state.lane}/${state.runTag}`).join(", ")}: the last continuation made no tool calls. Resume with /multiloop resume <lane/run-tag>.`,
          "warning"
        );
      }
      return;
    }

    queueLoopAutoContinue(pi, ctx, endedLoopReason);
  });

  interface StartLoopConfig {
    lane: string;
    runTag?: string;
    mode: LoopMode;
    goal: string;
    kind?: "goal" | "measured";
    tokenBudget?: number;
    verifyCommand?: string;
    guardCommand?: string;
    promptVerifier?: string;
    acceptancePolicy?: string;
    metricName?: string;
    metricDirection?: "lower" | "higher";
    acceptanceMode?: "log" | "keep-revert";
    scope?: string;
  }

  function startLoop(ctx: ExtensionContext | ExtensionCommandContext, config: StartLoopConfig): LoopState {
    const id: LaneId = { lane: config.lane, runTag: config.runTag ?? generateRunTag() };
    const acceptancePolicy = config.acceptancePolicy
      ?? (config.guardCommand || config.promptVerifier
        ? "metric must improve and all mechanical/prompt verification checks must pass"
        : undefined);
    const state = createInitialState(id, config.mode, config.verifyCommand, {
      kind: config.kind,
      tokenBudget: config.tokenBudget,
      guardCommand: config.guardCommand,
      promptVerifier: config.promptVerifier,
      acceptancePolicy,
      metricName: config.metricName,
      metricDirection: config.metricDirection ?? MODES[config.mode].defaultDirection,
      acceptanceMode: config.acceptanceMode ?? MODES[config.mode].defaultAcceptanceMode,
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


  const StartParams = Type.Object({
    lane: Type.String({ description: "Lane identifier for this loop" }),
    mode: Type.Union([
      Type.Literal("optimize"),
      Type.Literal("punchlist"),
      Type.Literal("research"),
      Type.Literal("dev"),
    ], { description: "Loop mode selected by the setup guide" }),
    goal: Type.String({ description: "Confirmed user goal" }),
    verifyCommand: Type.Optional(Type.String({ description: "Command that produces the primary metric. Omit only for a run with no metric, which then converges on a completion audit instead of a threshold." })),
    runTag: Type.Optional(Type.String({ description: "Run tag (auto-generated if omitted)" })),
    guardCommand: Type.Optional(Type.String({ description: "Optional pass/fail guard command" })),
    promptVerifier: Type.Optional(Type.String({ description: "Optional prompt-based correctness verifier / review criterion" })),
    acceptancePolicy: Type.Optional(Type.String({ description: "Acceptance rule, e.g. metric improves and all checks pass" })),
    metricName: Type.Optional(Type.String({ description: "Metric name" })),
    metricDirection: Type.Optional(Type.Union([Type.Literal("lower"), Type.Literal("higher")], { description: "Whether lower or higher metric values are better" })),
    acceptanceMode: Type.Optional(Type.Union([Type.Literal("log"), Type.Literal("keep-revert")], { description: "Acceptance behavior: log/progress or optimize-style keep/revert" })),
    scope: Type.Optional(Type.String({ description: "Files/directories in scope" })),
  });

  pi.registerTool({
    name: "multiloop_start",
    label: "Multiloop Start",
    description: "Phase 0 / launch: start a new pi-multiloop only after the setup guide has scanned the repo, asked clarifying questions, and received explicit user approval.",
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
    description: "Phase 1 / iterate: signal the start of one focused loop iteration. Call before making changes; after changes, run verify/guards and call multiloop_measure.",
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
          state.verifyCommand ? `Run verify command: \`${state.verifyCommand}\`` : "",
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
      minItems: 1,
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
      "Phase 2 / measure: record metric measurements and required mechanical/prompt check verdicts after running verify/guards. Then call multiloop_decide or multiloop_log.",
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

      if (params.measurements.length === 0) {
        return textResult("At least one measurement is required. Run the verify command and pass its numeric result to multiloop_measure.");
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
      minItems: 1,
      description: "Metric measurements for this iteration",
    }),
    hypothesis: Type.Optional(Type.String()),
    changes: Type.Optional(Type.String()),
  });

  pi.registerTool({
    name: "multiloop_decide",
    label: "Multiloop Decide",
    description:
      "Phase 3 / decide: finish the current measured keep/revert iteration with the recorded measurements. Required after multiloop_measure for optimize-style loops.",
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

      if (params.measurements.length === 0) {
        return textResult("At least one measurement is required. Use the measurements recorded by multiloop_measure.");
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
    action: Type.Optional(Type.Union([
      Type.Literal("log"),
      Type.Literal("skip"),
      Type.Literal("crash"),
      Type.Literal("blocked"),
    ], { description: "Result action for log-only records" })),
    metric: Type.Optional(Type.Number({ description: "Metric value to log" })),
    note: Type.Optional(Type.String({ description: "Free-text note for this iteration" })),
  });

  pi.registerTool({
    name: "multiloop_log",
    label: "Multiloop Log",
    description: "Phase 3 / log: finish a research/dev/punchlist iteration without keep/revert semantics, or record skip/crash/blocked after measurement/work.",
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
      const action = params.action ?? "log";
      const resultTimestamp = new Date().toISOString();
      appendResult(ctx.cwd, id, {
        iteration: state.iteration + 1,
        timestamp: resultTimestamp,
        action,
        metric,
        hypothesis: params.note ?? activeIteration?.hypothesis,
        measurements: activeIteration?.measurements,
        checks: activeIteration?.checks,
        acceptancePassed: activeIteration?.acceptancePassed,
        acceptanceReason: activeIteration?.acceptanceReason,
      });
      recordActionCounter(state, action, resultTimestamp);

      state.iteration++;
      delete state.activeIteration;
      if (metric !== undefined) {
        state.currentMetric = metric;
      }
      saveState(ctx.cwd, id, state);
      activeStates.set(stateKey(id), state);
      updateStatus(ctx);

      const lines = [`Recorded ${action} iteration ${state.iteration} for ${formatLaneId(id)}.${metric !== undefined ? ` Metric: ${metric}` : ""}`];
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

  function resolveCommandTarget(
    operation: "resume" | "pause" | "stop" | "archive",
    target: string,
    ctx: ExtensionCommandContext,
    statuses: RegistryEntry["status"][]
  ): TargetResolution {
    const registry = readRegistry(ctx.cwd);
    const resolution = resolveLoopTarget(registry.loops, target, { statuses });
    if (resolution.status !== "resolved") {
      ctx.ui.notify("Could not resolve multiloop target; handing off to the agent.", "error");
      pi.sendUserMessage(buildTargetDisambiguationPrompt(operation, target, resolution, registry.loops), { deliverAs: "followUp" });
    }
    return resolution;
  }

  function resumeLoop(ctx: ExtensionContext | ExtensionCommandContext, id: LaneId): LoopState | null {
    const state = reconstructState(ctx.cwd, id);
    if (!state) return null;
    state.status = "running";
    saveState(ctx.cwd, id, state);
    activeStates.set(stateKey(id), state);
    updateLoopStatus(ctx.cwd, id, "active");
    updateStatus(ctx);
    return state;
  }

  function pauseLoop(ctx: ExtensionContext | ExtensionCommandContext, id: LaneId): string {
    const key = stateKey(id);
    const state = activeStates.get(key) ?? reconstructState(ctx.cwd, id);
    if (!state) return `No state found for ${formatLaneId(id)}.`;

    state.status = "paused";
    saveState(ctx.cwd, id, state);
    updateLoopStatus(ctx.cwd, id, "paused");
    activeStates.delete(key);
    updateStatus(ctx);
    return `Paused loop ${formatLaneId(id)}.`;
  }

  function stopLoop(ctx: ExtensionContext | ExtensionCommandContext, id: LaneId): string {
    const key = stateKey(id);
    const state = activeStates.get(key) ?? reconstructState(ctx.cwd, id);
    if (!state) return `No state found for ${formatLaneId(id)}.`;

    state.status = "stopped";
    saveState(ctx.cwd, id, state);
    updateLoopStatus(ctx.cwd, id, "completed");
    activeStates.delete(key);
    updateStatus(ctx);
    return `Stopped loop ${formatLaneId(id)}.`;
  }

  function archiveLoopTarget(ctx: ExtensionContext | ExtensionCommandContext, id: LaneId): string {
    const loop = getLoop(ctx.cwd, id);
    if (!loop) return `No loop found: ${formatLaneId(id)}.`;
    const summary = loopSummary(ctx.cwd, loop);
    archiveLaneDirs(ctx.cwd, id);
    activeStates.delete(stateKey(id));
    updateStatus(ctx);
    return `Archived ${summary}.`;
  }

  function pauseAllActive(ctx: ExtensionCommandContext): string[] {
    const lines: string[] = [];
    const registry = readRegistry(ctx.cwd);
    const attached = new Set<string>();

    for (const [key, state] of activeStates.entries()) {
      if (state.status !== "running") continue;
      attached.add(key);
      lines.push(pauseLoop(ctx, { lane: state.lane, runTag: state.runTag }));
    }

    for (const entry of registry.loops) {
      const key = `${entry.lane}/${entry.runTag}`;
      if (entry.status === "active" && !attached.has(key)) {
        lines.push(pauseLoop(ctx, { lane: entry.lane, runTag: entry.runTag }));
      }
    }

    return lines;
  }

  function stopAllActive(ctx: ExtensionCommandContext): string[] {
    const lines: string[] = [];
    const registry = readRegistry(ctx.cwd);
    const attached = new Set<string>();

    for (const [key, state] of activeStates.entries()) {
      if (state.status !== "running") continue;
      attached.add(key);
      lines.push(stopLoop(ctx, { lane: state.lane, runTag: state.runTag }));
    }

    for (const entry of registry.loops) {
      const key = `${entry.lane}/${entry.runTag}`;
      if (entry.status === "active" && !attached.has(key)) {
        lines.push(stopLoop(ctx, { lane: entry.lane, runTag: entry.runTag }));
      }
    }

    return lines;
  }

  const HumanOperationParams = Type.Object({
    target: Type.String({ description: "Loop target as exact lane/run-tag, or lane-only when unambiguous" }),
  });

  pi.registerTool({
    name: "multiloop_resume",
    label: "Multiloop Resume",
    description: "Resume a paused, stopped, or detached pi-multiloop. Use after resolving the target; exact lane/run-tag is safest.",
    parameters: HumanOperationParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const registry = readRegistry(ctx.cwd);
      const resolution = resolveLoopTarget(registry.loops, params.target, { statuses: ["active", "paused", "completed"] });
      if (resolution.status !== "resolved") {
        return textResult(buildTargetDisambiguationPrompt("resume", params.target, resolution, registry.loops));
      }
      const state = resumeLoop(ctx, resolution.id);
      if (!state) return textResult(`No state found for ${formatLaneId(resolution.id)}.`);
      markLoopTurn("tool-resume");
      return textResult(`Resumed loop ${formatLaneId(resolution.id)} at iteration ${state.iteration}.\n\n${buildExplicitResumePrompt([state])}`);
    },
  });

  pi.registerTool({
    name: "multiloop_pause",
    label: "Multiloop Pause",
    description: "Pause a running or resumable pi-multiloop. Use exact lane/run-tag, or lane-only when unambiguous.",
    parameters: HumanOperationParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const registry = readRegistry(ctx.cwd);
      const resolution = resolveLoopTarget(registry.loops, params.target, { statuses: ["active", "paused"] });
      if (resolution.status !== "resolved") {
        return textResult(buildTargetDisambiguationPrompt("pause", params.target, resolution, registry.loops));
      }
      return textResult(pauseLoop(ctx, resolution.id));
    },
  });

  pi.registerTool({
    name: "multiloop_stop",
    label: "Multiloop Stop",
    description: "Stop a running, paused, or detached pi-multiloop without deleting files. Use exact lane/run-tag, or lane-only when unambiguous.",
    parameters: HumanOperationParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const registry = readRegistry(ctx.cwd);
      const resolution = resolveLoopTarget(registry.loops, params.target, { statuses: ["active", "paused", "completed"] });
      if (resolution.status !== "resolved") {
        return textResult(buildTargetDisambiguationPrompt("stop", params.target, resolution, registry.loops));
      }
      return textResult(stopLoop(ctx, resolution.id));
    },
  });

  pi.registerTool({
    name: "multiloop_archive",
    label: "Multiloop Archive",
    description: "Archive a non-archived pi-multiloop by moving its state directory under .multiloop/archive. Use exact lane/run-tag, or lane-only when unambiguous.",
    parameters: HumanOperationParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const registry = readRegistry(ctx.cwd);
      const resolution = resolveLoopTarget(registry.loops, params.target, { statuses: ["active", "paused", "completed"] });
      if (resolution.status !== "resolved") {
        return textResult(buildTargetDisambiguationPrompt("archive", params.target, resolution, registry.loops));
      }
      return textResult(archiveLoopTarget(ctx, resolution.id));
    },
  });

  function showStatus(ctx: ExtensionCommandContext) {
    const running = runningStates();
    if (running.length > 0) {
      const lines: string[] = [];
      for (const state of running) {
        lines.push(buildIterationContext(state));
        lines.push("");
      }

      pi.sendMessage({
        customType: "multiloop-status",
        content: lines.join("\n"),
        display: true,
      });
      return;
    }

    const registry = readRegistry(ctx.cwd);
    pi.sendMessage({
      customType: "multiloop-status",
      content: formatLoopStatusOverview(ctx.cwd, registry.loops, Array.from(activeStates.values())),
      display: true,
    });
  }

  async function archiveHandler(args: string, ctx: ExtensionCommandContext) {
    const trimmed = args.trim();

    if (trimmed) {
      const resolution = resolveCommandTarget("archive", trimmed, ctx, ["active", "paused", "completed"]);
      if (resolution.status !== "resolved") return;
      try {
        ctx.ui.notify(archiveLoopTarget(ctx, resolution.id), "info");
      } catch (err) {
        ctx.ui.notify(`Archive failed for ${formatLaneId(resolution.id)}: ${(err as Error).message}`, "error");
      }
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

  // ── Quick goal ─────────────────────────────────────────────────────────────

  /** The attached quick goal, if one is running or paused in this session. */
  function attachedQuickGoal(): LoopState | null {
    for (const state of activeStates.values()) {
      if (isQuickGoal(state) && (state.status === "running" || state.status === "paused")) return state;
    }
    return null;
  }

  function goalId(state: LoopState): LaneId {
    return { lane: state.lane, runTag: state.runTag };
  }

  function takenLanes(ctx: ExtensionContext | ExtensionCommandContext): string[] {
    return readRegistry(ctx.cwd).loops.map((loop) => loop.lane);
  }

  /** User-facing goal status. Never sent to the model. */
  function formatGoalStatus(state: LoopState): string {
    const accounting = readAccounting(state);
    return [
      `Goal ${state.lane}/${state.runTag} — ${state.status}`,
      `  ${state.goal ?? "(no objective recorded)"}`,
      `  mode ${state.mode}, ${state.iteration} recorded step${state.iteration === 1 ? "" : "s"}`,
      `  ${formatAccounting(accounting, state.tokenBudget)}`,
    ].join("\n");
  }

  function startQuickGoal(
    ctx: ExtensionCommandContext,
    objective: string,
    tokenBudget: number | undefined
  ): LoopState {
    const mode = deriveGoalMode(objective);
    const state = startLoop(ctx, {
      lane: deriveLane(objective, takenLanes(ctx)),
      mode,
      goal: objective,
      kind: "goal",
      tokenBudget,
    });

    ctx.ui.notify(
      [
        `Goal started: ${state.lane}/${state.runTag} (${mode})`,
        `  ${objective}`,
        tokenBudget === undefined ? undefined : `  token budget ${formatTokenCount(tokenBudget)}`,
        `  /goal pause to hold it, /goal to see progress, /multiloop stop ${state.lane}/${state.runTag} to end it.`,
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n"),
      "info"
    );

    markLoopTurn("goal-start");
    continuationsQueued = 0;
    toolCallsSinceContinuation = 0;
    pi.sendUserMessage(
      buildQuickGoalStartPrompt({ lane: state.lane, runTag: state.runTag, objective }),
      { deliverAs: "followUp" }
    );
    return state;
  }

  /** Reasons a goal may not be marked complete yet. */
  function completionBlocker(ctx: ExtensionContext, state: LoopState): string | null {
    if (state.allowOpenTasks === true) return null;
    const snapshot = taskSnapshotFor(ctx);
    if (snapshot === null || snapshot.open.length === 0) return null;
    return `The task list still has ${snapshot.open.length} open task${snapshot.open.length === 1 ? "" : "s"}. Finish or remove them, or the user can allow completion with /goal allow-open-tasks on.`;
  }

  function completeGoal(ctx: ExtensionContext, state: LoopState): string {
    const id = goalId(state);
    state.status = "completed";
    saveState(ctx.cwd, id, state);
    updateLoopStatus(ctx.cwd, id, "completed");
    activeStates.delete(stateKey(id));
    updateStatus(ctx);
    ctx.ui.notify(
      [`Goal complete: ${state.lane}/${state.runTag}`, `  ${state.goal ?? ""}`, `  ${formatAccounting(readAccounting(state), state.tokenBudget)}`].join("\n"),
      "info"
    );
    return `Goal ${state.lane}/${state.runTag} marked complete.`;
  }

  pi.registerTool({
    name: "get_goal",
    label: "Get Goal",
    description:
      "Read the active quick goal for this session: its objective, status, and whether anything is blocking completion. Use it to confirm what you are working toward.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const goal = attachedQuickGoal();
      if (!goal) return textResult("No quick goal is active. The user starts one with /goal <objective>.");
      const blocker = completionBlocker(ctx, goal);
      return textResult(
        [
          `Objective: ${goal.goal ?? ""}`,
          `Run: ${goal.lane}/${goal.runTag}`,
          `Status: ${goal.status}`,
          blocker ? `Completion blocked: ${blocker}` : "Completion gate: clear.",
        ].join("\n")
      );
    },
  });

  pi.registerTool({
    name: "update_goal",
    label: "Update Goal",
    description:
      'Mark the active quick goal complete.\nUse this only after the completion audit shows the objective has actually been achieved and no required work remains.\nDo not mark a goal complete because you are stopping work or running out of ideas.\nYou cannot pause, resume, or restart a goal with this tool; those are the user\'s to make.',
    parameters: Type.Object({
      status: Type.Literal("complete", { description: 'Only "complete" is accepted.' }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.status !== "complete") {
        return textResult("update_goal can only mark the goal complete; pause and resume are controlled by the user.");
      }
      const goal = attachedQuickGoal();
      if (!goal) return textResult("No quick goal is active, so there is nothing to complete.");
      if (goal.status !== "running") {
        return textResult(`Goal ${goal.lane}/${goal.runTag} is ${goal.status}; only a running goal can be completed.`);
      }
      const blocker = completionBlocker(ctx, goal);
      if (blocker) return textResult(`Not marking the goal complete. ${blocker}`);
      return textResult(completeGoal(ctx, goal));
    },
  });

  pi.registerCommand("goal", {
    description: "Set one objective and work toward it; a lightweight multiloop run",
    async handler(args, ctx) {
      const command = parseGoalCommand(args);
      if (command.kind === "error") {
        ctx.ui.notify(command.message, "error");
        return;
      }

      const goal = attachedQuickGoal();

      switch (command.kind) {
        case "help":
          pi.sendMessage({
            customType: "multiloop-help",
            content: [
              "/goal — set one objective and work toward it.",
              "",
              "  /goal <objective>            Start working now. Lane, mode, and scope are derived for you.",
              "  /goal --tokens 50k <obj>     Same, with a token cap that pauses the run when reached.",
              "  /goal                        Show the active goal and what it has cost.",
              "  /goal pause | resume         Hold the goal, or pick it back up.",
              "  /goal clear                  Detach the goal. Its history stays in .multiloop/.",
              "  /goal tokens <N|off>         Change or remove the token cap.",
              "  /goal allow-open-tasks <on|off>   Allow completion while tasks are still open.",
              "",
              "A goal is an ordinary multiloop run, so /multiloop ls, status, resume, and archive all work on it.",
              "For measured work with a metric and a verify command, use /multiloop instead.",
            ].join("\n"),
            display: true,
          });
          return;

        case "show":
          if (!goal) {
            ctx.ui.notify("No goal is active. Start one with /goal <objective>.", "info");
            return;
          }
          ctx.ui.notify(formatGoalStatus(goal), "info");
          return;

        case "setObjective": {
          let objective: string;
          try {
            objective = validateObjective(command.objective);
          } catch (err) {
            ctx.ui.notify((err as Error).message, "error");
            return;
          }

          if (goal) {
            // Replacing a goal must show what is being replaced, not just what
            // is proposed, and must never make the existing run disappear.
            const choice = ctx.hasUI
              ? await ctx.ui.select(
                  [
                    "A goal is already active.",
                    "",
                    formatGoalStatus(goal),
                    "",
                    `Proposed objective: ${objective}`,
                  ].join("\n"),
                  ["Pause current and start the new goal", "Stop current and start the new goal", "Keep the current goal"]
                )
              : "Pause current and start the new goal";
            if (choice === "Keep the current goal" || choice === undefined) {
              ctx.ui.notify("Kept the current goal.", "info");
              return;
            }
            const disposition = choice.startsWith("Stop") ? stopLoop(ctx, goalId(goal)) : pauseLoop(ctx, goalId(goal));
            ctx.ui.notify(`${disposition} Its history stays in .multiloop/.`, "info");
          }

          startQuickGoal(ctx, objective, command.tokenBudget);
          return;
        }

        case "setStatus": {
          if (!goal) {
            ctx.ui.notify("No goal is active. Start one with /goal <objective>.", "info");
            return;
          }
          if (command.status === "paused") {
            ctx.ui.notify(pauseLoop(ctx, goalId(goal)), "info");
            return;
          }
          const resumed = resumeLoop(ctx, goalId(goal));
          if (!resumed) {
            ctx.ui.notify(`No state found for ${formatLaneId(goalId(goal))}.`, "error");
            return;
          }
          ctx.ui.notify(`Resumed goal ${resumed.lane}/${resumed.runTag}.`, "info");
          markLoopTurn("goal-resume");
          continuationsQueued = 0;
          toolCallsSinceContinuation = 0;
          pi.sendUserMessage(buildAutoContinuePrompt([resumed], taskSnapshotFor(ctx)), { deliverAs: "followUp" });
          return;
        }

        case "clear": {
          if (!goal) {
            ctx.ui.notify("No goal is active.", "info");
            return;
          }
          const id = goalId(goal);
          activeStates.delete(stateKey(id));
          updateStatus(ctx);
          ctx.ui.notify(
            `Detached goal ${formatLaneId(id)}. Its state and history stay in .multiloop/; resume it with /multiloop resume ${formatLaneId(id)}.`,
            "info"
          );
          return;
        }

        case "showBudget":
          if (!goal) {
            ctx.ui.notify("No goal is active. Start one with /goal <objective>.", "info");
            return;
          }
          ctx.ui.notify(
            goal.tokenBudget === undefined
              ? `No token cap on ${goal.lane}/${goal.runTag}. Set one with /goal tokens <N>.`
              : `${goal.lane}/${goal.runTag}: ${formatAccounting(readAccounting(goal), goal.tokenBudget)}`,
            "info"
          );
          return;

        case "setBudget": {
          if (!goal) {
            ctx.ui.notify("No goal is active. Start one with /goal <objective>.", "info");
            return;
          }
          goal.tokenBudget = command.tokenBudget ?? undefined;
          saveState(ctx.cwd, goalId(goal), goal);
          ctx.ui.notify(
            command.tokenBudget === null
              ? `Removed the token cap on ${goal.lane}/${goal.runTag}.`
              : `Token cap for ${goal.lane}/${goal.runTag}: ${formatTokenCount(command.tokenBudget)}.`,
            "info"
          );
          return;
        }

        case "showAllowOpenTasks":
          if (!goal) {
            ctx.ui.notify("No goal is active. Start one with /goal <objective>.", "info");
            return;
          }
          ctx.ui.notify(
            goal.allowOpenTasks === true
              ? "allow-open-tasks: on — the goal can be completed while tasks are still open."
              : "allow-open-tasks: off — completion waits until the task list has no open tasks.",
            "info"
          );
          return;

        case "setAllowOpenTasks": {
          if (!goal) {
            ctx.ui.notify("No goal is active. Start one with /goal <objective>.", "info");
            return;
          }
          goal.allowOpenTasks = command.value;
          saveState(ctx.cwd, goalId(goal), goal);
          ctx.ui.notify(`allow-open-tasks ${command.value ? "enabled" : "disabled"}.`, "info");
          return;
        }
      }
    },
  });

  pi.registerCommand("multiloop", {
    description: "Start, resume, or manage autonomous iteration loops",
    async handler(args, ctx) {
      const trimmed = args.trim();

      if (trimmed === "resume" || trimmed.startsWith("resume ")) {
        const target = trimmed.replace(/^resume\s*/, "").trim();
        const resolution = resolveCommandTarget("resume", target, ctx, ["active", "paused", "completed"]);
        if (resolution.status !== "resolved") return;
        const state = resumeLoop(ctx, resolution.id);
        if (!state) {
          ctx.ui.notify(`No state found for ${formatLaneId(resolution.id)}`, "error");
          return;
        }
        ctx.ui.notify(`Resumed loop ${formatLaneId(resolution.id)} at iteration ${state.iteration}`, "info");
        markLoopTurn("explicit-resume");
        pi.sendUserMessage(buildExplicitResumePrompt([state]), { deliverAs: "followUp" });
        return;
      }

      if (trimmed === "stop" || trimmed.startsWith("stop ")) {
        const target = trimmed.replace(/^stop\s*/, "").trim();
        if (!target) {
          const lines = stopAllActive(ctx);
          ctx.ui.notify(lines.length > 0 ? lines.join("\n") : "No active loops to stop.", "info");
          return;
        }
        const resolution = resolveCommandTarget("stop", target, ctx, ["active", "paused", "completed"]);
        if (resolution.status !== "resolved") return;
        ctx.ui.notify(stopLoop(ctx, resolution.id), "info");
        return;
      }

      if (trimmed === "pause" || trimmed.startsWith("pause ")) {
        const target = trimmed.replace(/^pause\s*/, "").trim();
        if (!target) {
          const lines = pauseAllActive(ctx);
          ctx.ui.notify(lines.length > 0 ? lines.join("\n") : "No active loops to pause.", "info");
          return;
        }
        const resolution = resolveCommandTarget("pause", target, ctx, ["active", "paused"]);
        if (resolution.status !== "resolved") return;
        ctx.ui.notify(pauseLoop(ctx, resolution.id), "info");
        return;
      }

      if (trimmed === "list" || trimmed === "ls" || trimmed === "list --archived" || trimmed === "ls --archived") {
        const registry = readRegistry(ctx.cwd);
        const includeArchived = trimmed.endsWith("--archived");
        pi.sendMessage({
          customType: "multiloop-list",
          content: formatLoopList(ctx.cwd, registry.loops, { includeArchived }),
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

      if (!trimmed) {
        const registry = readRegistry(ctx.cwd);
        if (activeStates.size > 0 || registry.loops.length > 0) {
          pi.sendMessage({
            customType: "multiloop-status",
            content: formatLoopStatusOverview(ctx.cwd, registry.loops, Array.from(activeStates.values())),
            display: true,
          });
        } else {
          pi.sendUserMessage(buildSetupGuidePrompt(), { deliverAs: "followUp" });
        }
        return;
      }

      if (trimmed === "guide" || trimmed === "wizard" || trimmed === "setup") {
        pi.sendUserMessage(buildSetupGuidePrompt(), { deliverAs: "followUp" });
        return;
      }

      if (trimmed === "help") {
        pi.sendMessage({
          customType: "multiloop-help",
          content: [
            "pi-multiloop — run autonomous work with isolated state per lane.",
            "",
            "Two ways to start:",
            "  /goal <objective>   Start working now. No setup; lane and mode are derived for you.",
            "  /multiloop <seed>   Set up a measured run with a metric and a verify command.",
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
            "  guide            Propose a measured run and start it on one approval",
            "  resume <id>      Resume a stopped/paused loop",
            "  archive [id]     Archive completed loops (all by default)",
            "  rm <id>          Delete a loop and its state files",
            "  help             Show this help",
            "",
            "To start a measured run, describe the goal after /multiloop. For example:",
            '  /multiloop improve inference latency, verify: `./bench.py --quick`',
            '  /multiloop improve speed safely, verify: `./bench.py`, guard: `npm test`, prompt verifier: `Check output semantics against fixtures.`',
            "",
            "The agent scans the repo, proposes the whole configuration once, and starts",
            "on your approval. If the work has no metric to measure, use /goal instead —",
            "it starts immediately. Run /goal help for its commands.",
          ].join("\n"),
          display: true,
        });
        return;
      }

      pi.sendUserMessage(buildSetupGuidePrompt(trimmed), { deliverAs: "followUp" });
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
