import { describe, expect, it } from "vitest";
import { buildAutoContinuePrompt, buildCompactionResumePrompt, buildExplicitResumePrompt, buildResumableLoopsNotice, colorizeResumableLoopsNotice, decideCompactionResumeTiming } from "../extensions/pi-multiloop/index.js";
import { createInitialState } from "../extensions/pi-multiloop/state.js";

function activeState() {
  const state = createInitialState(
    { lane: "perf", runTag: "run-001" },
    "optimize",
    "./bench.py --quick",
    {
      guardCommand: "npm test",
      promptVerifier: "Review output for semantic equivalence to the baseline fixture.",
      acceptancePolicy: "metric improves and output remains correct",
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

describe("decideCompactionResumeTiming", () => {
  it("skips when no loops are running", () => {
    expect(decideCompactionResumeTiming({
      hasRunningStates: false,
      agentRunning: false,
      isIdle: true,
      now: 10_000,
      lastActiveAgentEndAt: 9_000,
      lastInputAt: 1_000,
    })).toBe("skip");
  });

  it("arms a resume for compaction that happens during an active agent turn", () => {
    expect(decideCompactionResumeTiming({
      hasRunningStates: true,
      agentRunning: true,
      isIdle: false,
      now: 10_000,
      lastActiveAgentEndAt: 0,
      lastInputAt: 1_000,
    })).toBe("after-current-agent-end");
  });

  it("sends a resume after auto-compaction that follows an active agent turn", () => {
    expect(decideCompactionResumeTiming({
      hasRunningStates: true,
      agentRunning: false,
      isIdle: true,
      now: 10_000,
      lastActiveAgentEndAt: 9_900,
      lastInputAt: 1_000,
    })).toBe("after-compaction");
  });

  it("skips manual idle compaction", () => {
    expect(decideCompactionResumeTiming({
      hasRunningStates: true,
      agentRunning: false,
      isIdle: true,
      now: 10_000,
      lastActiveAgentEndAt: 1_000,
      lastInputAt: 500,
      recentWindowMs: 100,
    })).toBe("skip");
  });

  it("skips pre-prompt compaction because the submitted prompt will continue", () => {
    expect(decideCompactionResumeTiming({
      hasRunningStates: true,
      agentRunning: false,
      isIdle: true,
      now: 10_000,
      lastActiveAgentEndAt: 9_000,
      lastInputAt: 9_950,
    })).toBe("skip");
  });
});

describe("buildResumableLoopsNotice", () => {
  it("lists resumable loops without implying attachment", () => {
    const lines = buildResumableLoopsNotice("/tmp", [{
      lane: "perf",
      runTag: "run-001",
      mode: "optimize",
      status: "active",
      startedAt: "2026-05-06T00:00:00.000Z",
      stateDir: ".multiloop/active/perf/run-001",
    }]);

    expect(lines[0]).toContain("pi-multiloop");
    expect(lines[0]).toContain("1 active · detached");
    expect(lines.join("\n")).toContain(" · perf/run-001");
    expect(lines.join("\n")).toContain("❯  /multiloop resume <lane/run-tag>");
    expect(lines.join("\n")).not.toContain("↳");
  });

  it("colorizes notice text for the custom message renderer", () => {
    const lines = buildResumableLoopsNotice("/tmp", [{
      lane: "perf",
      runTag: "run-001",
      mode: "optimize",
      status: "active",
      startedAt: "2026-05-06T00:00:00.000Z",
      stateDir: ".multiloop/active/perf/run-001",
    }]);
    const styled = colorizeResumableLoopsNotice(lines.join("\n"), {
      fg: (name, text) => `<${name}>${text}</${name}>`,
      bold: (text) => `**${text}**`,
    });

    expect(styled).toContain("<mdHeading>**pi-multiloop**</mdHeading>");
    expect(styled).toContain("<accent>perf/run-001</accent>");
    expect(styled).toContain("<syntaxFunction>/multiloop resume</syntaxFunction>");
  });
});

describe("buildExplicitResumePrompt", () => {
  it("builds a loop-aware prompt for explicit resume", () => {
    const prompt = buildExplicitResumePrompt([activeState()]);

    expect(prompt).toContain("Resume active pi-multiloop work from persisted state.");
    expect(prompt).toContain("## Active Loop: perf/run-001");
    expect(prompt).toContain("Goal: improve inference latency");
    expect(prompt).toContain("Verify: `./bench.py --quick`");
    expect(prompt).toContain("Do not start a new loop");
  });
});

describe("buildAutoContinuePrompt", () => {
  it("demands baseline measurement when no baseline is recorded", () => {
    const state = activeState();
    state.baseline = null;
    state.currentMetric = null;
    state.bestMetric = null;

    const prompt = buildAutoContinuePrompt([state]);

    expect(prompt).toContain("Continue active pi-multiloop work.");
    expect(prompt).toContain("Do not answer with a status report");
    expect(prompt).toContain("baseline is not recorded");
    expect(prompt).toContain("multiloop_measure");
  });

  it("demands a decision for a measured active iteration", () => {
    const state = activeState();
    state.activeIteration = {
      iteration: 4,
      phase: "measured",
      startedAt: "2026-05-07T00:00:00.000Z",
      measurements: [356],
      metric: 356,
      recommendedAction: "revert",
      measuredAt: "2026-05-07T00:01:00.000Z",
    };

    const prompt = buildAutoContinuePrompt([state]);

    expect(prompt).toContain("iteration 4 has measurements [356]");
    expect(prompt).toContain("multiloop_decide action=\"revert\"");
    expect(prompt).toContain("before any status/final answer");
  });
});

describe("buildCompactionResumePrompt", () => {
  it("builds a loop-aware resume prompt after compaction", () => {
    const prompt = buildCompactionResumePrompt([activeState()], "cmp-123");

    expect(prompt).toContain("Continue active pi-multiloop work after context compaction.");
    expect(prompt).toContain("Compaction entry: cmp-123");
    expect(prompt).toContain("## Active Loop: perf/run-001");
    expect(prompt).toContain("Goal: improve inference latency");
    expect(prompt).toContain("Verify: `./bench.py --quick`");
    expect(prompt).toContain("Guard: `npm test`");
    expect(prompt).toContain("Prompt verifier: Review output for semantic equivalence");
    expect(prompt).toContain("metric improves and output remains correct");
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
