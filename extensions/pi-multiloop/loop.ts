import type { LaneId } from "./lanes.js";
import {
  type LoopState,
  type IterationResult,
  type ResultAction,
  loadState,
  saveState,
  appendResult,
  appendLesson,
  reconstructState,
  recordActionCounter,
  formatActionCounters,
} from "./state.js";
import {
  type ConfidenceResult,
  assessConfidence,
  isImprovement,
  formatDelta,
} from "./metrics.js";
import { updateLoopStatus, formatLaneId } from "./lanes.js";

export interface LoopDecision {
  action: ResultAction;
  reason: string;
  shouldEscalate: boolean;
  escalationType?: "refine" | "pivot" | "stop";
}

export interface EscalationState {
  consecutiveFailures: number;
  pivotCount: number;
  shouldStop: boolean;
  message: string;
}

const REFINE_THRESHOLD = 3;
const PIVOT_THRESHOLD = 5;
const MAX_PIVOTS = 2;
const REANCHOR_INTERVAL = 10;

export function failureEscalationDecision(state: LoopState): Pick<LoopDecision, "shouldEscalate" | "escalationType"> {
  const escalation = checkEscalation(
    state.consecutiveFailures + 1,
    state.pivotCount
  );

  return {
    shouldEscalate: escalation.consecutiveFailures >= REFINE_THRESHOLD,
    escalationType: escalation.shouldStop
      ? "stop"
      : escalation.pivotCount > state.pivotCount
        ? "pivot"
        : escalation.consecutiveFailures >= REFINE_THRESHOLD
          ? "refine"
          : undefined,
  };
}

export function decide(
  state: LoopState,
  measurement: ConfidenceResult,
  baseline: number
): LoopDecision {
  if (state.mode === "research" || state.mode === "dev") {
    return {
      action: "log",
      reason: `Logged measurement: ${measurement.median}`,
      shouldEscalate: false,
    };
  }

  const improved = isImprovement(
    baseline,
    measurement.median,
    measurement.mad,
    state.metricDirection
  );

  if (improved) {
    const delta = formatDelta(baseline, measurement.median, state.metricDirection);
    return {
      action: "keep",
      reason: `Improvement: ${delta} (confidence: ${measurement.confidence})`,
      shouldEscalate: false,
    };
  }

  const escalation = failureEscalationDecision(state);

  return {
    action: "revert",
    reason: `No improvement: ${formatDelta(baseline, measurement.median, state.metricDirection)}`,
    shouldEscalate: escalation.shouldEscalate,
    escalationType: escalation.escalationType,
  };
}

export function checkEscalation(
  consecutiveFailures: number,
  pivotCount: number
): EscalationState {
  if (pivotCount >= MAX_PIVOTS && consecutiveFailures >= PIVOT_THRESHOLD) {
    return {
      consecutiveFailures,
      pivotCount,
      shouldStop: true,
      message: `Exhausted ${MAX_PIVOTS} pivots with ${consecutiveFailures} consecutive failures. Stopping.`,
    };
  }

  if (consecutiveFailures >= PIVOT_THRESHOLD) {
    return {
      consecutiveFailures,
      pivotCount: pivotCount + 1,
      shouldStop: false,
      message: `${consecutiveFailures} consecutive failures. Pivoting to a new approach (pivot ${pivotCount + 1}/${MAX_PIVOTS}).`,
    };
  }

  if (consecutiveFailures >= REFINE_THRESHOLD) {
    return {
      consecutiveFailures,
      pivotCount,
      shouldStop: false,
      message: `${consecutiveFailures} consecutive failures. Refining current approach.`,
    };
  }

  return {
    consecutiveFailures,
    pivotCount,
    shouldStop: false,
    message: "",
  };
}

export function applyDecision(
  cwd: string,
  id: LaneId,
  state: LoopState,
  decision: LoopDecision,
  measurement: ConfidenceResult,
  hypothesis?: string,
  changes?: string
): LoopState {
  const activeIteration = state.activeIteration;
  const result: IterationResult = {
    iteration: state.iteration + 1,
    timestamp: new Date().toISOString(),
    action: decision.action,
    metric: measurement.median,
    baseline: state.currentMetric ?? state.baseline ?? undefined,
    delta: state.currentMetric != null
      ? measurement.median - state.currentMetric
      : undefined,
    confidence: measurement.confidence,
    hypothesis,
    changes,
    reason: decision.reason,
    shouldEscalate: decision.shouldEscalate,
    escalationType: decision.escalationType,
    measurements: measurement.measurements,
    checks: activeIteration?.checks,
    acceptancePassed: activeIteration?.acceptancePassed,
    acceptanceReason: activeIteration?.acceptanceReason,
  };

  appendResult(cwd, id, result);
  recordActionCounter(state, decision.action, result.timestamp);

  state.iteration++;
  delete state.activeIteration;

  if (decision.action === "keep") {
    state.currentMetric = measurement.median;
    state.consecutiveFailures = 0;
    if (state.bestMetric === null) {
      state.bestMetric = measurement.median;
    } else {
      state.bestMetric = state.metricDirection === "lower"
        ? Math.min(state.bestMetric, measurement.median)
        : Math.max(state.bestMetric, measurement.median);
    }
  } else if (decision.action === "revert") {
    state.consecutiveFailures++;
    if (decision.escalationType === "pivot") {
      state.pivotCount++;
      state.consecutiveFailures = 0;
      appendLesson(cwd, id, `Pivot ${state.pivotCount}: Previous approach exhausted after ${PIVOT_THRESHOLD} failures.`);
    }
  } else if (decision.action === "log") {
    state.currentMetric = measurement.median;
  }

  if (decision.escalationType === "stop") {
    state.status = "stopped";
    updateLoopStatus(cwd, id, "completed");
  }

  saveState(cwd, id, state);
  return state;
}

export function shouldReanchor(iteration: number): boolean {
  return iteration > 0 && iteration % REANCHOR_INTERVAL === 0;
}

export function reanchor(cwd: string, id: LaneId): LoopState | null {
  return reconstructState(cwd, id);
}

export function buildIterationContext(state: LoopState): string {
  const lines: string[] = [];
  lines.push(`## Active Loop: ${state.lane}/${state.runTag}`);
  lines.push(`Mode: ${state.mode} | Iteration: ${state.iteration} | Status: ${state.status}`);
  lines.push(`Actions: ${formatActionCounters(state)}`);
  lines.push(`Acceptance mode: ${state.acceptanceMode ?? (state.mode === "optimize" ? "keep-revert" : "log")}`);

  if (state.goal) {
    lines.push(`Goal: ${state.goal}`);
  }

  if (state.baseline !== null) {
    lines.push(`Baseline ${state.metricName ?? "metric"}: ${state.baseline}`);
  }
  if (state.currentMetric !== null) {
    lines.push(`Current: ${state.currentMetric}`);
  }
  if (state.bestMetric !== null) {
    lines.push(`Best: ${state.bestMetric}`);
  }

  lines.push(`Verify: \`${state.verifyCommand}\``);
  if (state.guardCommand) {
    lines.push(`Guard: \`${state.guardCommand}\``);
  }
  if (state.promptVerifier) {
    lines.push(`Prompt verifier: ${state.promptVerifier}`);
  }
  if (state.acceptancePolicy) {
    lines.push(`Acceptance policy: ${state.acceptancePolicy}`);
  } else if (state.guardCommand || state.promptVerifier) {
    lines.push("Acceptance policy: metric must improve and all verification checks must pass");
  }
  if (state.scope) {
    lines.push(`Scope: ${state.scope}`);
  }

  if (state.activeIteration) {
    lines.push(`Active iteration: ${state.activeIteration.iteration} (${state.activeIteration.phase})`);
    if (state.activeIteration.hypothesis) {
      lines.push(`Active hypothesis: ${state.activeIteration.hypothesis}`);
    }
    if (state.activeIteration.phase === "measured") {
      lines.push(`Pending measurements: [${state.activeIteration.measurements?.join(", ") ?? ""}]`);
      if (state.activeIteration.checks && state.activeIteration.checks.length > 0) {
        const failed = state.activeIteration.checks.filter((check) => !check.passed).map((check) => check.name);
        lines.push(`Pending checks: ${failed.length === 0 ? "all passed" : `failed ${failed.join(", ")}`}`);
      }
      if (state.activeIteration.acceptanceReason) {
        const acceptanceStatus = state.activeIteration.acceptancePassed === undefined
          ? "UNKNOWN"
          : state.activeIteration.acceptancePassed ? "PASS" : "FAIL";
        lines.push(`Acceptance: ${acceptanceStatus} — ${state.activeIteration.acceptanceReason}`);
      }
      if (state.activeIteration.recommendedAction) {
        lines.push(`Pending decision: ${state.activeIteration.recommendedAction}`);
      }
    }
  }

  if (state.consecutiveFailures > 0) {
    lines.push(`Consecutive failures: ${state.consecutiveFailures}`);
  }
  if (state.pivotCount > 0) {
    lines.push(`Pivots: ${state.pivotCount}/${MAX_PIVOTS}`);
  }

  return lines.join("\n");
}

export function buildEscalationPrompt(
  escalationType: "refine" | "pivot" | "stop",
  state: LoopState
): string {
  switch (escalationType) {
    case "refine":
      return `After ${state.consecutiveFailures} consecutive failures, refine your approach. Review what was tried, identify why it didn't work, and try a different variation of the same strategy.`;
    case "pivot":
      return `After ${PIVOT_THRESHOLD} consecutive failures, pivot to a fundamentally different approach. The current strategy is exhausted — try something qualitatively different.`;
    case "stop":
      return `Loop stopped: exhausted ${MAX_PIVOTS} pivots without improvement. Review the results log and summarize findings.`;
  }
}
