import { describe, expect, it } from "vitest";
import { projectLoopActivity } from "../extensions/pi-multiloop/activity.js";
import { createInitialState, type LoopState } from "../extensions/pi-multiloop/state.js";

const scope = { sessionId: "session", branchId: "branch" };
function state(overrides: Partial<LoopState> = {}): LoopState {
  return { ...createInitialState({ lane: "dev", runTag: "one" }, "dev", undefined, { goal: "ship" }), ...overrides };
}

describe("loop activity projection", () => {
  it("includes goal, progress, lifecycle and retained terminal runs without modifying producer state", () => {
    const statuses = ["running", "paused", "stopped", "completed", "archived"] as const;
    const states = statuses.map((status, iteration) => state({ status, iteration, runTag: status, kind: iteration === 0 ? "goal" : "measured" }));
    const before = JSON.stringify(states);
    const snapshot = projectLoopActivity(scope, 7, states);
    expect(snapshot.complete).toBe(true);
    expect(snapshot.availability).toBe("available");
    expect(snapshot.revision).toBe(7);
    expect(snapshot.runs).toHaveLength(5);
    expect(snapshot.runs.find((run) => run.runTag === "running")?.kind).toBe("goal");
    expect(snapshot.runs.find((run) => run.runTag === "completed")?.iteration).toBe(3);
    expect(snapshot.runs.map((run) => run.status).sort()).toEqual([...statuses].sort());
    expect(JSON.stringify(states)).toBe(before);
    snapshot.scope.sessionId = "changed";
    snapshot.runs[0].metric.current = 99;
    expect(scope.sessionId).toBe("session");
    expect(JSON.stringify(states)).toBe(before);
  });

  it("keeps recorded active time distinct from absolute timestamps and unknown legacy values", () => {
    const legacy = state({ startedAt: "invalid", finishedAt: undefined, accounting: undefined });
    const [run] = projectLoopActivity(scope, 1, [legacy]).runs;
    expect(run.startedAt).toBeNull();
    expect(run.heldAt).toBeNull();
    expect(run.activeSeconds).toBeNull();
    expect(run.kind).toBe("loop");
    const modern = state({ startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-02T00:00:00Z", accounting: { activeSeconds: 12, turns: 2, toolCalls: 1, inputTokens: 1, outputTokens: 1 } });
    const projected = projectLoopActivity(scope, 2, [modern]).runs[0];
    expect(projected.startedAt).toBe(Date.parse(modern.startedAt));
    expect(projected.heldAt).toBe(Date.parse(modern.finishedAt!));
    expect(projected.activeSeconds).toBe(12);
    modern.currentMetric = Infinity;
    expect(projectLoopActivity(scope, 3, [modern]).runs[0].metric.current).toBeNull();
  });

  it("uses lane and run-tag pairs, rejects duplicate identities and represents complete emptiness", () => {
    const runs = [state({ lane: "a/b", runTag: "c" }), state({ lane: "a", runTag: "b/c" })];
    expect(projectLoopActivity(scope, 1, runs).runs).toHaveLength(2);
    expect(() => projectLoopActivity(scope, 2, [runs[0], runs[0]])).toThrow(/Duplicate/);
    expect(projectLoopActivity(scope, 3, []).runs).toEqual([]);
  });
});
