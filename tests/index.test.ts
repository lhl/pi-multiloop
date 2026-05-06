import { describe, expect, it } from "vitest";
import { buildCompactionResumePrompt } from "../extensions/pi-multiloop/index.js";
import { createInitialState } from "../extensions/pi-multiloop/state.js";

function activeState() {
  const state = createInitialState(
    { lane: "perf", runTag: "run-001" },
    "optimize",
    "./bench.py --quick",
    {
      guardCommand: "npm test",
      goal: "improve inference latency",
      metricDirection: "lower",
    }
  );
  state.iteration = 3;
  state.baseline = 100;
  state.currentMetric = 92;
  state.bestMetric = 90;
  return state;
}

describe("buildCompactionResumePrompt", () => {
  it("builds a loop-aware resume prompt after compaction", () => {
    const prompt = buildCompactionResumePrompt([activeState()], "cmp-123");

    expect(prompt).toContain("Continue active pi-multiloop work after context compaction.");
    expect(prompt).toContain("Compaction entry: cmp-123");
    expect(prompt).toContain("## Active Loop: perf/run-001");
    expect(prompt).toContain("Goal: improve inference latency");
    expect(prompt).toContain("Verify: `./bench.py --quick`");
    expect(prompt).toContain("Guard: `npm test`");
    expect(prompt).toContain("multiloop_iterate");
    expect(prompt).toContain("multiloop_measure");
    expect(prompt).toContain("multiloop_decide or multiloop_log");
  });

  it("omits the compaction entry line when unavailable", () => {
    const prompt = buildCompactionResumePrompt([activeState()]);

    expect(prompt).not.toContain("Compaction entry:");
    expect(prompt).not.toContain("undefined");
  });
});
