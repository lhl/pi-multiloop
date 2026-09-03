import { describe, expect, it } from "vitest";
import {
  budgetExhausted,
  buildAutoContinuePrompt,
  buildCompactionResumePrompt,
  buildExplicitResumePrompt,
  buildLoopStartPrompt,
  buildSetupGuidePrompt,
  formatAccounting,
  formatDuration,
  formatTokenCount,
} from "../extensions/pi-multiloop/index.js";
import {
  accountedTokens,
  createInitialState,
  emptyAccounting,
  isQuickGoal,
  readAccounting,
  type LoopState,
} from "../extensions/pi-multiloop/state.js";
import {
  buildQuickGoalContinuationPrompt,
  buildQuickGoalStartPrompt,
} from "../extensions/pi-multiloop/goal.js";

function goalState(overrides: Partial<LoopState> = {}): LoopState {
  const state = createInitialState({ lane: "ship-installer", runTag: "run-001" }, "dev", undefined, {
    kind: "goal",
    goal: "ship the installer fix",
  });
  return { ...state, ...overrides };
}

function measuredState(): LoopState {
  const state = createInitialState({ lane: "perf", runTag: "run-002" }, "optimize", "./bench.py", {
    goal: "reduce latency",
    metricName: "p50_ms",
  });
  state.baseline = 120;
  state.currentMetric = 110;
  state.bestMetric = 110;
  return state;
}

describe("run kind", () => {
  it("marks a goal run and leaves measured runs alone", () => {
    expect(isQuickGoal(goalState())).toBe(true);
    expect(isQuickGoal(measuredState())).toBe(false);
  });

  it("treats a state written before the field existed as a measured run", () => {
    const legacy = measuredState();
    delete legacy.kind;
    expect(isQuickGoal(legacy)).toBe(false);
  });

  it("gives a quick goal no verify command", () => {
    expect(goalState().verifyCommand).toBeUndefined();
  });
});

describe("accounting", () => {
  it("starts empty and reads back a state that predates the field", () => {
    expect(readAccounting(goalState())).toEqual(emptyAccounting());
    const legacy = measuredState();
    delete legacy.accounting;
    expect(readAccounting(legacy)).toEqual(emptyAccounting());
  });

  it("charges input plus output against a budget", () => {
    expect(accountedTokens({ activeSeconds: 0, turns: 0, toolCalls: 0, inputTokens: 400, outputTokens: 600 })).toBe(1000);
  });

  it("reports exhaustion only for a budgeted run that reached its cap", () => {
    const unbudgeted = goalState();
    unbudgeted.accounting = { activeSeconds: 10, turns: 2, toolCalls: 9, inputTokens: 9_000, outputTokens: 3_000 };
    expect(budgetExhausted(unbudgeted)).toBe(false);

    const budgeted = goalState({ tokenBudget: 10_000 });
    budgeted.accounting = { activeSeconds: 10, turns: 2, toolCalls: 9, inputTokens: 6_000, outputTokens: 3_000 };
    expect(budgetExhausted(budgeted)).toBe(false);

    budgeted.accounting = { activeSeconds: 10, turns: 2, toolCalls: 9, inputTokens: 7_000, outputTokens: 3_000 };
    expect(budgetExhausted(budgeted)).toBe(true);
  });
});

describe("buildLoopStartPrompt", () => {
  it("tells a measured run to establish a baseline", () => {
    const prompt = buildLoopStartPrompt(measuredState());
    expect(prompt).toContain("Verify: `./bench.py`");
    expect(prompt).toContain("Metric: p50_ms (lower)");
    expect(prompt).toContain("establish a baseline");
    expect(prompt).toContain("multiloop_measure");
  });

  it("does not send a metric-free run after a verify command it does not have", () => {
    const prompt = buildLoopStartPrompt(goalState());
    expect(prompt).toContain("No verify command: this run has no metric.");
    expect(prompt).not.toContain("establish a baseline");
    expect(prompt).not.toContain("multiloop_measure");
    expect(prompt).not.toContain("Metric direction");
    expect(prompt).toContain("multiloop_log");
  });
});

describe("user-facing formatting", () => {
  it("formats durations at each scale", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(90)).toBe("1m");
    expect(formatDuration(3_600)).toBe("1h");
    expect(formatDuration(3_900)).toBe("1h 5m");
    expect(formatDuration(200_000)).toBe("2d 7h 33m");
  });

  it("formats token counts compactly", () => {
    expect(formatTokenCount(940)).toBe("940");
    expect(formatTokenCount(12_400)).toBe("12.4K");
    expect(formatTokenCount(2_000_000)).toBe("2M");
  });

  it("names every counter and the budget when one is set", () => {
    const accounting = { activeSeconds: 3_900, turns: 12, toolCalls: 41, inputTokens: 180_000, outputTokens: 20_000 };
    expect(formatAccounting(accounting)).toBe("time 1h 5m, 12 turns, 41 tool calls, 200K tokens");
    expect(formatAccounting(accounting, 500_000)).toBe("time 1h 5m, 12 turns, 41 tool calls, 200K of 500K tokens");
  });

  it("uses singular forms for a single turn or tool call", () => {
    expect(formatAccounting({ activeSeconds: 5, turns: 1, toolCalls: 1, inputTokens: 1, outputTokens: 1 })).toBe(
      "time 5s, 1 turn, 1 tool call, 2 tokens"
    );
  });
});

/**
 * The release contract: work accounting is reported to the user and never to
 * the model. A cumulative counter delivered in-context every turn reads as a
 * context-window gauge regardless of its label, and models have curtailed
 * active work in response to one.
 */
describe("model-facing prompts carry no work accounting", () => {
  const budgetedGoal = goalState({ tokenBudget: 250_000 });
  budgetedGoal.accounting = {
    activeSeconds: 7_200,
    turns: 40,
    toolCalls: 210,
    inputTokens: 190_000,
    outputTokens: 30_000,
  };

  const prompts: Array<[string, string]> = [
    ["quick-goal start", buildQuickGoalStartPrompt({ lane: "g", runTag: "r", objective: "ship it" })],
    ["quick-goal continuation", buildQuickGoalContinuationPrompt({ lane: "g", runTag: "r", objective: "ship it" })],
    ["auto continue (goal)", buildAutoContinuePrompt([budgetedGoal])],
    ["auto continue (measured)", buildAutoContinuePrompt([measuredState()])],
    ["explicit resume", buildExplicitResumePrompt([budgetedGoal, measuredState()])],
    ["compaction resume", buildCompactionResumePrompt([budgetedGoal], "entry-1")],
    ["loop start (goal)", buildLoopStartPrompt(budgetedGoal)],
    ["loop start (measured)", buildLoopStartPrompt(measuredState())],
    ["setup guide", buildSetupGuidePrompt("make it faster")],
  ];

  // "token" would also match legitimate loop vocabulary, so each pattern
  // targets the accounting phrasing specifically.
  const banned: Array<[string, RegExp]> = [
    ["token counts", /tokens?\s*(used|remaining|spent|left|budget)/i],
    ["a token budget", /token\s*budget|budget\s*(of|remaining|limit)/i],
    ["elapsed time", /time\s*(used|spent|elapsed)|elapsed\s*(time|seconds)/i],
    ["turn counts", /\d+\s*turns?\b/i],
    ["tool-call counts", /\d+\s*tool\s*calls?\b/i],
    ["a context percentage", /\d+\s*%\s*(of\s*)?context/i],
  ];

  for (const [name, prompt] of prompts) {
    for (const [description, pattern] of banned) {
      it(`${name} states no ${description}`, () => {
        expect(prompt).not.toMatch(pattern);
      });
    }
  }

  it("still names the run so the agent knows what it is continuing", () => {
    expect(buildAutoContinuePrompt([budgetedGoal])).toContain("ship-installer/run-001");
    expect(buildAutoContinuePrompt([budgetedGoal])).toContain("ship the installer fix");
  });
});
