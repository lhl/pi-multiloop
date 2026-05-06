import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import {
  type LaneId,
  type RegistryEntry,
  getActiveLoops,
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
  applyDecision,
  shouldReanchor,
  reanchor,
  buildIterationContext,
  buildEscalationPrompt,
} from "./loop.js";
import { MODES, detectMode } from "./modes.js";

const activeStates = new Map<string, LoopState>();
let agentRunning = false;
let resumeAfterCompact = false;
let lastCompactionEntryId: string | undefined;

function stateKey(id: LaneId): string {
  return `${id.lane}/${id.runTag}`;
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

function runningStates(): LoopState[] {
  return Array.from(activeStates.values()).filter((state) => state.status === "running");
}

export function buildCompactionResumePrompt(
  states: LoopState[],
  compactionEntryId?: string
): string {
  const contexts = states.map((state) => buildIterationContext(state)).join("\n\n");
  return [
    "Continue active pi-multiloop work after context compaction.",
    compactionEntryId ? `Compaction entry: ${compactionEntryId}` : undefined,
    "",
    "Do not start a new loop and do not ask for confirmation. Resume from the persisted .multiloop state exactly where the loop left off.",
    "",
    contexts,
    "",
    "Next:",
    "- If an iteration was not in progress, call multiloop_iterate for the appropriate lane.",
    "- Run the loop's verify command and guard command if present.",
    "- Record results with multiloop_measure, then finish with multiloop_decide or multiloop_log.",
    "- If state is ambiguous, inspect .multiloop/active/<lane>/<runTag>/state.json and results.jsonl before proceeding.",
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
  }
  if (state != null && state.baseline !== null && state.bestMetric !== null && state.baseline !== state.bestMetric) {
    details.push(`${state.baseline} → ${state.bestMetric}`);
  }
  parts.push(`(${details.join(", ")})`);

  return parts.join(" — ");
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const loops = getActiveLoops(ctx.cwd);
    for (const entry of loops) {
      const id: LaneId = { lane: entry.lane, runTag: entry.runTag };
      const state = reconstructState(ctx.cwd, id);
      if (state && state.status === "running") {
        activeStates.set(stateKey(id), state);
      }
    }
    if (activeStates.size > 0) {
      ctx.ui.setStatus(
        "multiloop",
        `multiloop: ${activeStates.size} active loop${activeStates.size > 1 ? "s" : ""}`
      );
    }
  });

  pi.on("agent_start", async () => {
    agentRunning = true;
  });

  pi.on("session_compact", async (event, ctx) => {
    if (runningStates().length === 0) return;

    // Manual /compact while idle should not restart the agent. Auto-compaction during
    // an active multiloop turn can leave the agent at an idle prompt, so queue a
    // loop-aware resume for the next agent_end.
    if (!agentRunning && ctx.isIdle()) return;

    resumeAfterCompact = true;
    lastCompactionEntryId = event.compactionEntry.id;
  });

  pi.on("agent_end", async (_event, ctx) => {
    agentRunning = false;

    if (!resumeAfterCompact) return;
    const compactionEntryId = lastCompactionEntryId;
    resumeAfterCompact = false;
    lastCompactionEntryId = undefined;

    const states = runningStates();
    if (states.length === 0 || ctx.hasPendingMessages()) return;

    setTimeout(() => {
      const latestStates = runningStates();
      if (latestStates.length === 0) return;
      try {
        pi.sendUserMessage(buildCompactionResumePrompt(latestStates, compactionEntryId));
      } catch (err) {
        ctx.ui.notify(`multiloop resume after compact failed: ${(err as Error).message}`, "error");
      }
    }, 0);
  });

  pi.on("before_agent_start", async (event, _ctx) => {
    if (activeStates.size === 0) return;

    const contexts: string[] = [];
    for (const state of activeStates.values()) {
      contexts.push(buildIterationContext(state));
    }

    const append = [
      "\n\n# Active Multiloop Loops\n",
      ...contexts,
      "\n\nUse the multiloop_iterate, multiloop_measure, and multiloop_decide tools to execute loop iterations.",
    ].join("\n");

    return {
      systemPrompt: event.systemPrompt + append,
    };
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

      return textResult(
        [
          `Iteration ${state.iteration + 1} starting for ${formatLaneId(id)}.`,
          state.currentMetric !== null
            ? `Current ${state.metricName ?? "metric"}: ${state.currentMetric}`
            : `No baseline yet — this iteration will establish it.`,
          params.hypothesis ? `Hypothesis: ${params.hypothesis}` : "",
          `Run verify command: \`${state.verifyCommand}\``,
          state.guardCommand ? `Then run guard: \`${state.guardCommand}\`` : "",
        ]
          .filter(Boolean)
          .join("\n")
      );
    },
  });

  const MeasureParams = Type.Object({
    lane: Type.String({ description: "Lane identifier" }),
    measurements: Type.Array(Type.Number(), {
      description: "Array of metric measurements (run verify multiple times for confidence)",
    }),
  });

  pi.registerTool({
    name: "multiloop_measure",
    label: "Multiloop Measure",
    description:
      "Record measurements from running the verify command. Pass multiple measurements for statistical confidence.",
    parameters: MeasureParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const id = findLane(params.lane);
      if (!id) {
        return textResult(`No active loop in lane "${params.lane}".`);
      }

      const state = activeStates.get(stateKey(id));
      if (!state) {
        return textResult(`No state for lane "${params.lane}".`);
      }

      const confidence = assessConfidence(params.measurements);

      if (state.baseline === null) {
        state.baseline = confidence.median;
        state.currentMetric = confidence.median;
        state.bestMetric = confidence.median;
        saveState(ctx.cwd, id, state);

        return textResult(
          [
            `Baseline established for ${formatLaneId(id)}:`,
            `  ${state.metricName ?? "Metric"}: ${confidence.median}`,
            `  MAD: ${confidence.mad}`,
            `  Confidence: ${confidenceLabel(confidence.confidence)}`,
            `  Measurements: [${params.measurements.join(", ")}]`,
            "",
            "Baseline recorded. Start optimizing.",
          ].join("\n")
        );
      }

      const baseline = state.currentMetric ?? state.baseline;
      const improved = isImprovement(baseline, confidence.median, confidence.mad, state.metricDirection);

      return textResult(
        [
          `Measurement for ${formatLaneId(id)}:`,
          `  ${state.metricName ?? "Metric"}: ${confidence.median}`,
          `  Baseline: ${baseline}`,
          `  Delta: ${formatDelta(baseline, confidence.median, state.metricDirection)}`,
          `  MAD: ${confidence.mad} | Confidence: ${confidenceLabel(confidence.confidence)}`,
          `  Improved: ${improved ? "YES" : "NO"}`,
          "",
          `Call multiloop_decide with action="${improved ? "keep" : "revert"}" to proceed.`,
        ].join("\n")
      );
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
      "Record keep/revert decision for current iteration. Updates state and logs the result.",
    parameters: DecideParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
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

      const confidence = assessConfidence(params.measurements);
      const baseline = state.currentMetric ?? state.baseline!;

      const decision = {
        action: params.action as "keep" | "revert" | "log" | "skip",
        reason: params.action === "keep"
          ? `Kept: ${formatDelta(baseline, confidence.median, state.metricDirection)}`
          : params.action === "revert"
            ? `Reverted: ${formatDelta(baseline, confidence.median, state.metricDirection)}`
            : `Logged: ${confidence.median}`,
        shouldEscalate: false,
        escalationType: undefined as "refine" | "pivot" | "stop" | undefined,
      };

      if (params.action === "revert") {
        const esc = decide(state, confidence, baseline);
        decision.shouldEscalate = esc.shouldEscalate;
        decision.escalationType = esc.escalationType;
      }

      state = applyDecision(
        ctx.cwd,
        id,
        state,
        decision,
        confidence,
        params.hypothesis,
        params.changes
      );

      activeStates.set(stateKey(id), state);
      updateStatus(ctx);

      const lines = [
        `Iteration ${state.iteration} complete for ${formatLaneId(id)}:`,
        `  Action: ${params.action.toUpperCase()}`,
        `  ${state.metricName ?? "Metric"}: ${confidence.median}`,
        `  Consecutive failures: ${state.consecutiveFailures}`,
      ];

      if (decision.shouldEscalate && decision.escalationType) {
        lines.push("");
        lines.push(buildEscalationPrompt(decision.escalationType, state));
      }

      if (state.status === "stopped") {
        lines.push("");
        lines.push("Loop has been stopped due to escalation exhaustion.");
        activeStates.delete(stateKey(id));
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
      const id = findLane(params.lane);
      if (!id) {
        return textResult(`No active loop in lane "${params.lane}".`);
      }

      const state = activeStates.get(stateKey(id));
      if (!state) {
        return textResult(`No state for lane "${params.lane}".`);
      }

      appendResult(ctx.cwd, id, {
        iteration: state.iteration + 1,
        timestamp: new Date().toISOString(),
        action: "log",
        metric: params.metric,
        hypothesis: params.note,
      });

      state.iteration++;
      if (params.metric !== undefined) {
        state.currentMetric = params.metric;
      }
      saveState(ctx.cwd, id, state);
      activeStates.set(stateKey(id), state);

      return textResult(
        `Logged iteration ${state.iteration} for ${formatLaneId(id)}.${params.metric !== undefined ? ` Metric: ${params.metric}` : ""}`
      );
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

      if (trimmed === "help" || !trimmed) {
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
            "  resume <id>      Resume a stopped/paused loop",
            "  archive [id]     Archive completed loops (all by default)",
            "  rm <id>          Delete a loop and its state files",
            "  help             Show this help",
            "",
            "To start a new loop, just describe your goal after /multiloop. For example:",
            '  /multiloop improve inference latency, verify: `./bench.py --quick`',
            "",
            "If you need help setting one up, just ask — describe what you want to",
            "optimize, research, or build and the agent will configure the loop for you.",
          ].join("\n"),
          display: true,
        });
        return;
      }

      const mode = detectMode(trimmed);
      const runTag = generateRunTag();
      const laneParts = trimmed.match(/lane[:\s]+(\w+)/i);
      const lane = laneParts?.[1] ?? mode;

      const id: LaneId = { lane, runTag };
      const verifyParts = trimmed.match(/verify[:\s]+`([^`]+)`/i) ??
        trimmed.match(/verify[:\s]+"([^"]+)"/i);
      const verifyCommand = verifyParts?.[1] ?? "echo 'TODO: set verify command'";

      const guardParts = trimmed.match(/guard[:\s]+`([^`]+)`/i) ??
        trimmed.match(/guard[:\s]+"([^"]+)"/i);

      const state = createInitialState(id, mode, verifyCommand, {
        guardCommand: guardParts?.[1],
        goal: trimmed,
        metricDirection: MODES[mode].defaultDirection,
      });

      ensureLaneDir(ctx.cwd, id);
      saveState(ctx.cwd, id, state);

      const entry: RegistryEntry = {
        lane: id.lane,
        runTag: id.runTag,
        mode,
        status: "active",
        startedAt: state.startedAt,
        stateDir: `.multiloop/active/${id.lane}/${id.runTag}`,
        verifyCommand,
        guardCommand: guardParts?.[1],
      };
      registerLoop(ctx.cwd, entry);

      activeStates.set(stateKey(id), state);
      updateStatus(ctx);

      pi.sendUserMessage(
        [
          `New ${mode} loop started: ${formatLaneId(id)}`,
          `Verify: \`${verifyCommand}\``,
          guardParts?.[1] ? `Guard: \`${guardParts[1]}\`` : null,
          `Goal: ${trimmed}`,
          "",
          "Run the verify command to establish a baseline, then begin iterating.",
        ]
          .filter((l): l is string => l !== null)
          .join("\n"),
        { deliverAs: "steer" }
      );
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

  function updateStatus(ctx: { ui: { setStatus(key: string, text: string | undefined): void } }) {
    if (activeStates.size > 0) {
      const summaries = Array.from(activeStates.values()).map(
        (s) => `${s.lane}#${s.iteration}`
      );
      ctx.ui.setStatus("multiloop", `multiloop: ${summaries.join(", ")}`);
    } else {
      ctx.ui.setStatus("multiloop", undefined);
    }
  }
}
