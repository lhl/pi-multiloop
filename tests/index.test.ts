import { describe, expect, it } from "vitest";
import { buildAutoContinuePrompt, buildCompactionResumePrompt, buildExplicitResumePrompt, buildResumableLoopsNotice, buildSetupGuidePrompt, buildTargetDisambiguationPrompt, colorizeResumableLoopsNotice, decideCompactionResumeTiming, formatLoopList, formatLoopStatusOverview } from "../extensions/pi-multiloop/index.js";
import { createInitialState } from "../extensions/pi-multiloop/state.js";
import type { RegistryEntry } from "../extensions/pi-multiloop/lanes.js";

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

describe("buildSetupGuidePrompt", () => {
  it("asks the agent to scan, clarify, confirm, and start with multiloop_start", () => {
    const prompt = buildSetupGuidePrompt();

    expect(prompt).toContain("Scan the repo before proposing a loop");
    expect(prompt).toContain("Ask at least one repo-grounded clarification round");
    expect(prompt).toContain("metric improves and every check passes");
    expect(prompt).toContain("call multiloop_start");
    expect(prompt).toContain("Reply go to start");
  });

  it("includes a freeform goal seed when provided", () => {
    const prompt = buildSetupGuidePrompt("finish docs/TODO.md safely");

    expect(prompt).toContain("User goal seed: finish docs/TODO.md safely");
    expect(prompt).toContain("Scan the repo before proposing a loop");
  });
});

function entry(overrides: Partial<RegistryEntry>): RegistryEntry {
  return {
    lane: "perf",
    runTag: "run-001",
    mode: "optimize",
    status: "active",
    startedAt: "2026-05-01T00:00:00.000Z",
    stateDir: ".multiloop/active/perf/run-001",
    ...overrides,
  };
}

describe("formatLoopList", () => {
  it("groups reverse-chronological loops and hides archived by default", () => {
    const output = formatLoopList("/tmp", [
      entry({ lane: "old", runTag: "run-001", status: "completed", startedAt: "2026-05-01T00:00:00.000Z" }),
      entry({ lane: "new", runTag: "run-002", status: "active", startedAt: "2026-05-03T00:00:00.000Z" }),
      entry({ lane: "paused", runTag: "run-003", status: "paused", startedAt: "2026-05-02T00:00:00.000Z" }),
      entry({ lane: "arch", runTag: "run-004", status: "archived", startedAt: "2026-05-04T00:00:00.000Z" }),
    ]);

    expect(output).toContain("Active / resumable:");
    expect(output).toContain("Paused:");
    expect(output).toContain("Completed / stopped:");
    expect(output).not.toContain("Archived:\n");
    expect(output).toContain("1 archived loop is hidden");
    expect(output.indexOf("new/run-002")).toBeLessThan(output.indexOf("paused/run-003"));
  });

  it("includes archived loops when requested", () => {
    const output = formatLoopList("/tmp", [
      entry({ lane: "arch", runTag: "run-004", status: "archived", startedAt: "2026-05-04T00:00:00.000Z" }),
    ], { includeArchived: true });

    expect(output).toContain("Archived:");
    expect(output).toContain("arch/run-004");
  });
});

describe("buildTargetDisambiguationPrompt", () => {
  it("asks the model to use typed tools or ask the user", () => {
    const prompt = buildTargetDisambiguationPrompt("pause", "perf", {
      status: "ambiguous",
      input: "perf",
      matches: [entry({ runTag: "run-001" }), entry({ runTag: "run-002" })],
      message: "Lane matches multiple loops.",
    }, [entry({ runTag: "run-001" }), entry({ runTag: "run-002" })]);

    expect(prompt).toContain("Resolve a pi-multiloop pause request");
    expect(prompt).toContain("Requested target: perf");
    expect(prompt).toContain("multiloop_pause");
    expect(prompt).toContain("ask the user to choose");
    expect(prompt).toContain("perf/run-001");
  });
});

describe("formatLoopStatusOverview", () => {
  it("shows attached, detached, inactive, and archived buckets", () => {
    const state = activeState();
    const output = formatLoopStatusOverview("/tmp", [
      entry({ lane: "perf", runTag: "run-001", status: "active" }),
      entry({ lane: "detached", runTag: "run-002", status: "active" }),
      entry({ lane: "paused", runTag: "run-003", status: "paused" }),
      entry({ lane: "arch", runTag: "run-004", status: "archived" }),
    ], [state]);

    expect(output).toContain("Attached running loops:");
    expect(output).toContain("perf/run-001");
    expect(output).toContain("keeps=0, reverts=0, logs=0, crashes=0, blocked=0");
    expect(output).toContain("Detached resumable loops:");
    expect(output).toContain("detached/run-002");
    expect(output).toContain("Inactive/history:");
    expect(output).toContain("paused/run-003");
    expect(output).toContain("Archived: 1 run hidden");
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
    expect(prompt).toContain("If the user asked a status question or other query, answer it first");
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
    expect(prompt).toContain("if the user asked a question, answer it");
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
