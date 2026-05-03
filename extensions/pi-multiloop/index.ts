import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
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
  readRegistry,
} from "./lanes.js";
import {
  type LoopState,
  createInitialState,
  saveState,
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

function stateKey(id: LaneId): string {
  return `${id.lane}/${id.runTag}`;
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
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

      const confidence = assessConfidence(params.measurements);
      const baseline = state.currentMetric ?? state.baseline ?? 0;

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
        for (const [key, state] of activeStates.entries()) {
          if (!laneName || state.lane === laneName) {
            const id: LaneId = { lane: state.lane, runTag: state.runTag };
            state.status = "stopped";
            saveState(ctx.cwd, id, state);
            updateLoopStatus(ctx.cwd, id, "completed");
            activeStates.delete(key);
            ctx.ui.notify(`Stopped loop ${formatLaneId(id)}`, "info");
          }
        }
        updateStatus(ctx);
        return;
      }

      if (trimmed === "pause" || trimmed.startsWith("pause ")) {
        const laneName = trimmed.replace(/^pause\s*/, "").trim();
        for (const [key, state] of activeStates.entries()) {
          if (!laneName || state.lane === laneName) {
            const id: LaneId = { lane: state.lane, runTag: state.runTag };
            state.status = "paused";
            saveState(ctx.cwd, id, state);
            updateLoopStatus(ctx.cwd, id, "paused");
            activeStates.delete(key);
            ctx.ui.notify(`Paused loop ${formatLaneId(id)}`, "info");
          }
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
            `${l.status === "active" ? "*" : " "} ${l.lane}/${l.runTag} [${l.mode}] ${l.status}`
        );
        pi.sendMessage({
          customType: "multiloop-list",
          content: lines.join("\n"),
          display: true,
        });
        return;
      }

      if (!trimmed) {
        pi.sendUserMessage(
          "I want to start a new multiloop. Please help me configure it — ask me about: the goal, mode (optimize/punchlist/research/dev), verify command, guard command, lane name, and scope.",
          { deliverAs: "steer" }
        );
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

  pi.registerCommand("multiloop-status", {
    description: "Show status of all active loops",
    async handler(_args, ctx) {
      if (activeStates.size === 0) {
        const registry = readRegistry(ctx.cwd);
        if (registry.loops.length === 0) {
          ctx.ui.notify("No active loops.", "info");
        } else {
          const lines = registry.loops.map(
            (l) => `  ${l.lane}/${l.runTag} [${l.mode}] ${l.status}`
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
    },
  });

  pi.registerCommand("multiloop-archive", {
    description: "Archive a completed loop's state directory",
    async handler(args, ctx) {
      const id = parseLaneId(args.trim());
      if (!id) {
        ctx.ui.notify(`Invalid lane/run-tag: "${args.trim()}". Format: lane/run-tag`, "error");
        return;
      }

      const loop = getLoop(ctx.cwd, id);
      if (!loop) {
        ctx.ui.notify(`No loop found: ${formatLaneId(id)}`, "error");
        return;
      }

      const dest = archiveLaneDirs(ctx.cwd, id);
      activeStates.delete(stateKey(id));
      updateStatus(ctx);
      ctx.ui.notify(`Archived ${formatLaneId(id)} → ${dest}`, "info");
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
