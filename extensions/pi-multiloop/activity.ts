import type { LoopState } from "./state.js";

/** The caller supplies ownership from its attachment, never from a display label. */
export interface LoopActivityScope {
  sessionId: string;
  branchId: string;
}

/** Serializable activity facts. Reading these facts does not resume or acknowledge a run. */
export interface LoopActivity {
  lane: string;
  runTag: string;
  kind: "goal" | "loop";
  status: LoopState["status"];
  mode: string;
  goal: string | null;
  iteration: number;
  activeIteration: number | null;
  metric: { name: string | null; current: number | null; best: number | null };
  /** Absolute producer timestamps, in milliseconds since the Unix epoch. */
  startedAt: number | null;
  updatedAt: number | null;
  /** Last pause or terminal transition; null after resume. Not necessarily completion. */
  heldAt: number | null;
  /** Accumulated recorded agent work, not wall-clock age or time since attachment. */
  activeSeconds: number | null;
}

export interface LoopActivitySnapshot {
  version: 1;
  scope: LoopActivityScope;
  revision: number;
  availability: "available" | "unavailable";
  complete: boolean;
  runs: LoopActivity[];
}

function timestamp(value: string | undefined): number | null {
  if (!value) return null;
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : null;
}
function finite(value: number | undefined | null): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Pure projection of an explicitly scoped, complete producer inventory. */
export function projectLoopActivity(
  scope: LoopActivityScope,
  revision: number,
  states: readonly LoopState[],
): LoopActivitySnapshot {
  const seen = new Set<string>();
  const runs = states.map((state): LoopActivity => {
    const identity = JSON.stringify([state.lane, state.runTag]);
    if (seen.has(identity)) throw new Error("Duplicate loop activity identity");
    seen.add(identity);
    return {
      lane: state.lane,
      runTag: state.runTag,
      kind: state.kind === "goal" ? "goal" : "loop",
      status: state.status,
      mode: state.mode,
      goal: state.goal ?? null,
      iteration: state.iteration,
      activeIteration: state.activeIteration?.iteration ?? null,
      metric: { name: state.metricName ?? null, current: finite(state.currentMetric), best: finite(state.bestMetric) },
      startedAt: timestamp(state.startedAt),
      updatedAt: timestamp(state.lastUpdated),
      heldAt: timestamp(state.finishedAt),
      activeSeconds: finite(state.accounting?.activeSeconds),
    };
  });
  runs.sort((a, b) => a.lane.localeCompare(b.lane) || a.runTag.localeCompare(b.runTag));
  return { version: 1, scope: { ...scope }, revision, availability: "available", complete: true, runs };
}
