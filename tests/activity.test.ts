import { describe, expect, it, vi } from "vitest";
import { LoopActivityPublisher, projectLoopActivity } from "../extensions/pi-multiloop/activity.js";
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

describe("loop activity publisher", () => {
  const mine = { owner: "session", state: state({ lane: "mine", runTag: "one" }) };
  const theirs = { owner: "other", state: state({ lane: "theirs", runTag: "two" }) };
  const unowned = { owner: undefined, state: state({ lane: "orphan", runTag: "three" }) };

  it("reports only the runs the requesting session attached", () => {
    const publisher = new LoopActivityPublisher({ entries: () => [mine, theirs, unowned] });
    const snapshot = publisher.snapshot({ sessionId: "session" });
    expect(snapshot.runs.map((run) => run.lane)).toEqual(["mine"]);
    expect(snapshot.availability).toBe("available");
    expect(snapshot.complete).toBe(true);
    expect(publisher.snapshot({ sessionId: "elsewhere" }).runs).toEqual([]);
  });

  it("advances the revision and notifies every subscriber, isolating failures", () => {
    const publisher = new LoopActivityPublisher({ entries: () => [mine] });
    const healthy = vi.fn();
    const failing = vi.fn(() => {
      throw new Error("consumer failed");
    });
    const unsubscribe = publisher.subscribe(healthy);
    publisher.subscribe(failing);
    const before = publisher.snapshot({ sessionId: "session" }).revision;
    publisher.changed();
    expect(failing).toHaveBeenCalledTimes(1);
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(publisher.snapshot({ sessionId: "session" }).revision).toBe(before + 1);
    unsubscribe();
    publisher.dispose();
    publisher.changed();
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it("reports unavailable rather than empty when the producer cannot answer", () => {
    let available = true;
    const publisher = new LoopActivityPublisher({
      entries: () => {
        if (!available) throw new Error("workspace unreadable");
        return [mine];
      },
      available: () => available,
    });
    expect(publisher.snapshot({ sessionId: "session" }).runs).toHaveLength(1);
    available = false;
    const down = publisher.snapshot({ sessionId: "session" });
    expect(down.availability).toBe("unavailable");
    expect(down.complete).toBe(false);
    expect(down.runs).toEqual([]);
    available = true;
    const broken = new LoopActivityPublisher({
      entries: () => {
        throw new Error("workspace unreadable");
      },
    });
    expect(broken.snapshot({ sessionId: "session" }).availability).toBe("unavailable");
  });
});
