import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  decide,
  checkEscalation,
  applyDecision,
  shouldReanchor,
  buildIterationContext,
  buildEscalationPrompt,
} from "../extensions/pi-multiloop/loop.js";
import {
  type LoopState,
  createInitialState,
  saveState,
  loadState,
} from "../extensions/pi-multiloop/state.js";
import type { LaneId } from "../extensions/pi-multiloop/lanes.js";
import type { ConfidenceResult } from "../extensions/pi-multiloop/metrics.js";

function m(median: number, mad: number, confidence: "high" | "medium" | "low" = "high"): ConfidenceResult {
  return {
    median,
    mad,
    confidence,
    measurements: [median],
    isSignificant: true,
  };
}

function makeState(overrides: Partial<LoopState> = {}): LoopState {
  const id: LaneId = { lane: "test", runTag: "run-001" };
  return {
    ...createInitialState(id, "optimize", "echo 42"),
    baseline: 100,
    currentMetric: 100,
    bestMetric: 100,
    iteration: 0,
    ...overrides,
  };
}

let cwd: string;
const id: LaneId = { lane: "test", runTag: "run-001" };

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "multiloop-loop-test-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("checkEscalation", () => {
  it("returns no escalation for low consecutive failures", () => {
    const result = checkEscalation(0, 0);
    expect(result.shouldStop).toBe(false);
    expect(result.message).toBe("");
    expect(result.pivotCount).toBe(0);
  });

  it("returns refine at REFINE_THRESHOLD (3)", () => {
    const result = checkEscalation(3, 0);
    expect(result.shouldStop).toBe(false);
    expect(result.message).toContain("Refining");
    expect(result.pivotCount).toBe(0);
  });

  it("returns refine between REFINE_THRESHOLD and PIVOT_THRESHOLD", () => {
    const result = checkEscalation(4, 0);
    expect(result.shouldStop).toBe(false);
    expect(result.message).toContain("Refining");
    expect(result.pivotCount).toBe(0);
  });

  it("pivots at PIVOT_THRESHOLD (5) with no prior pivots", () => {
    const result = checkEscalation(5, 0);
    expect(result.shouldStop).toBe(false);
    expect(result.message).toContain("Pivoting");
    expect(result.message).toContain("pivot 1/2");
    expect(result.pivotCount).toBe(1);
  });

  it("pivots again at PIVOT_THRESHOLD with 1 prior pivot", () => {
    const result = checkEscalation(5, 1);
    expect(result.shouldStop).toBe(false);
    expect(result.message).toContain("Pivoting");
    expect(result.message).toContain("pivot 2/2");
    expect(result.pivotCount).toBe(2);
  });

  it("stops when PIVOT_THRESHOLD hit with MAX_PIVOTS reached", () => {
    const result = checkEscalation(5, 2);
    expect(result.shouldStop).toBe(true);
    expect(result.message).toContain("Stopping");
    expect(result.pivotCount).toBe(2);
  });

  it("stops at 6 failures with 2 pivots (above threshold)", () => {
    const result = checkEscalation(6, 2);
    expect(result.shouldStop).toBe(true);
  });
});

describe("decide", () => {
  it("returns log action for research mode", () => {
    const state = makeState({ mode: "research" });
    const result = decide(state, m(95, 5), 100);
    expect(result.action).toBe("log");
    expect(result.shouldEscalate).toBe(false);
  });

  it("returns log action for dev mode", () => {
    const state = makeState({ mode: "dev" });
    const result = decide(state, m(95, 5), 100);
    expect(result.action).toBe("log");
    expect(result.shouldEscalate).toBe(false);
  });

  it("returns keep when lower-is-better improvement detected", () => {
    const state = makeState({ metricDirection: "lower", currentMetric: 100 });
    const result = decide(state, m(80, 5), 100);
    expect(result.action).toBe("keep");
    expect(result.reason).toContain("Improvement");
    expect(result.shouldEscalate).toBe(false);
  });

  it("returns keep when higher-is-better improvement detected", () => {
    const state = makeState({ metricDirection: "higher", currentMetric: 100 });
    const result = decide(state, m(120, 5), 100);
    expect(result.action).toBe("keep");
  });

  it("returns revert without escalation for first failure", () => {
    const state = makeState({ consecutiveFailures: 0 });
    const result = decide(state, m(100, 1), 100);
    expect(result.action).toBe("revert");
    expect(result.shouldEscalate).toBe(false);
  });

  it("returns revert with refine on 3rd consecutive failure", () => {
    const state = makeState({ consecutiveFailures: 2 });
    const result = decide(state, m(100, 1), 100);
    expect(result.action).toBe("revert");
    expect(result.shouldEscalate).toBe(true);
    expect(result.escalationType).toBe("refine");
  });

  it("returns revert with pivot on 5th consecutive failure", () => {
    const state = makeState({ consecutiveFailures: 4, pivotCount: 0 });
    const result = decide(state, m(100, 1), 100);
    expect(result.action).toBe("revert");
    expect(result.shouldEscalate).toBe(true);
    expect(result.escalationType).toBe("pivot");
  });

  it("returns revert with stop when pivots exhausted", () => {
    const state = makeState({ consecutiveFailures: 4, pivotCount: 2 });
    const result = decide(state, m(100, 1), 100);
    expect(result.action).toBe("revert");
    expect(result.escalationType).toBe("stop");
  });
});

describe("applyDecision", () => {
  it("increments iteration and saves result on keep", () => {
    const state = makeState();
    saveState(cwd, id, state);

    const result = applyDecision(cwd, id, state, {
      action: "keep",
      reason: "Improved",
      shouldEscalate: false,
    }, m(85, 3), "try unrolling", "unrolled loop");

    expect(result.iteration).toBe(1);
    expect(result.currentMetric).toBe(85);
    expect(result.bestMetric).toBe(85);
    expect(result.consecutiveFailures).toBe(0);

    const saved = loadState(cwd, id);
    expect(saved).not.toBeNull();
    expect(saved!.iteration).toBe(1);
    expect(saved!.currentMetric).toBe(85);
  });

  it("updates bestMetric correctly for lower-is-better", () => {
    const state = makeState({ metricDirection: "lower", currentMetric: 100, bestMetric: 100 });

    // First keep: 85 is better than 100
    applyDecision(cwd, id, state, {
      action: "keep",
      reason: "Improved",
      shouldEscalate: false,
    }, m(85, 3));

    // Second keep: 90 is worse than best
    const state2 = loadState(cwd, id)!;
    applyDecision(cwd, id, state2, {
      action: "keep",
      reason: "Improved",
      shouldEscalate: false,
    }, m(90, 3));

    const final = loadState(cwd, id)!;
    expect(final.bestMetric).toBe(85); // best remains 85
    expect(final.currentMetric).toBe(90);
  });

  it("updates bestMetric correctly for higher-is-better", () => {
    const state = makeState({ metricDirection: "higher", currentMetric: 100, bestMetric: 100 });

    applyDecision(cwd, id, state, {
      action: "keep",
      reason: "Improved",
      shouldEscalate: false,
    }, m(120, 3));

    const final = loadState(cwd, id)!;
    expect(final.bestMetric).toBe(120);
  });

  it("increments consecutive failures on revert", () => {
    const state = makeState({ consecutiveFailures: 1 });
    saveState(cwd, id, state);

    const result = applyDecision(cwd, id, state, {
      action: "revert",
      reason: "No improvement",
      shouldEscalate: false,
    }, m(105, 3));

    expect(result.consecutiveFailures).toBe(2);
    expect(result.currentMetric).toBe(100); // unchanged
  });

  it("resets failures and increments pivot on pivot escalation", () => {
    const state = makeState({ consecutiveFailures: 4, pivotCount: 0 });
    saveState(cwd, id, state);

    const result = applyDecision(cwd, id, state, {
      action: "revert",
      reason: "No improvement",
      shouldEscalate: true,
      escalationType: "pivot",
    }, m(105, 3));

    expect(result.consecutiveFailures).toBe(0);
    expect(result.pivotCount).toBe(1);

    // Verify lesson was written
    const lessonsFile = join(cwd, ".multiloop", "active", "test", "run-001", "lessons.md");
    expect(existsSync(lessonsFile)).toBe(true);
    const lessons = readFileSync(lessonsFile, "utf-8");
    expect(lessons).toContain("Pivot 1");
    expect(lessons).toContain("Previous approach exhausted");
  });

  it("sets status to stopped and updates registry on stop", () => {
    const state = makeState();
    saveState(cwd, id, state);

    const result = applyDecision(cwd, id, state, {
      action: "revert",
      reason: "No improvement",
      shouldEscalate: true,
      escalationType: "stop",
    }, m(105, 3));

    expect(result.status).toBe("stopped");
  });
});

describe("shouldReanchor", () => {
  it("returns false for iteration 0", () => {
    expect(shouldReanchor(0)).toBe(false);
  });

  it("returns false for non-multiple of 10", () => {
    expect(shouldReanchor(5)).toBe(false);
    expect(shouldReanchor(11)).toBe(false);
  });

  it("returns true every 10 iterations starting from 10", () => {
    expect(shouldReanchor(10)).toBe(true);
    expect(shouldReanchor(20)).toBe(true);
    expect(shouldReanchor(100)).toBe(true);
  });
});

describe("buildIterationContext", () => {
  it("includes lane, mode, iteration, status", () => {
    const state = makeState();
    const ctx = buildIterationContext(state);
    expect(ctx).toContain("test/run-001");
    expect(ctx).toContain("optimize");
    expect(ctx).toContain("Iteration: 0");
    expect(ctx).toContain("running");
  });

  it("includes goal when present", () => {
    const state = makeState({ goal: "reduce latency" });
    expect(buildIterationContext(state)).toContain("reduce latency");
  });

  it("includes metric info when baseline is set", () => {
    const state = makeState({ baseline: 100, currentMetric: 85, bestMetric: 80 });
    const ctx = buildIterationContext(state);
    expect(ctx).toContain("Baseline");
    expect(ctx).toContain("100");
    expect(ctx).toContain("Current:");
    expect(ctx).toContain("85");
    expect(ctx).toContain("Best:");
    expect(ctx).toContain("80");
  });

  it("shows failure and pivot counts when non-zero", () => {
    const state = makeState({ consecutiveFailures: 3, pivotCount: 1 });
    const ctx = buildIterationContext(state);
    expect(ctx).toContain("Consecutive failures: 3");
    expect(ctx).toContain("Pivots: 1/2");
  });

  it("includes scope when set", () => {
    const state = makeState({ scope: "src/kernel/" });
    expect(buildIterationContext(state)).toContain("src/kernel/");
  });
});

describe("buildEscalationPrompt", () => {
  it("returns refine message", () => {
    const state = makeState({ consecutiveFailures: 3 });
    const msg = buildEscalationPrompt("refine", state);
    expect(msg).toContain("3 consecutive failures");
    expect(msg).toContain("refine");
  });

  it("returns pivot message", () => {
    const state = makeState();
    const msg = buildEscalationPrompt("pivot", state);
    expect(msg).toContain("pivot");
    expect(msg).toContain("fundamentally different");
  });

  it("returns stop message", () => {
    const state = makeState();
    const msg = buildEscalationPrompt("stop", state);
    expect(msg).toContain("stopped");
    expect(msg).toContain("summarize findings");
  });
});