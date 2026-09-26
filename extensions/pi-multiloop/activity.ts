import type { LoopState } from "./state.js";

/**
 * Request/response and invalidation channels on Pi's event bus.
 *
 * `LOOP_ACTIVITY_REQUEST` carries `{ version: 1, sessionId, respond }`. The producer calls
 * `respond` once, synchronously, with a snapshot scoped to that session. A consumer that
 * receives no response is talking to a producer without this interface; it must not assume
 * the run list is empty. `LOOP_ACTIVITY_CHANGED` carries no payload, so a consumer reads a
 * fresh snapshot instead of trusting a delta it cannot validate.
 */
export const LOOP_ACTIVITY_REQUEST = "multiloop:activity";
export const LOOP_ACTIVITY_CHANGED = "multiloop:activity:changed";
export interface LoopActivityRequest {
  version: 1;
  sessionId: string;
  respond: (snapshot: LoopActivitySnapshot) => void;
}

/** The caller supplies ownership from its attachment, never from a display label. */
export interface LoopActivityScope {
  sessionId: string;
  /** Loops are session-scoped; a branch is recorded only when a caller supplies one. */
  branchId?: string;
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

/** A retained run and the session that attached it, when a session did. */
export interface LoopActivityEntry {
  owner: string | undefined;
  state: LoopState;
}

export interface LoopActivityPublisherOptions {
  /**
   * Complete enumeration of the runs this producer still holds: live attached runs plus
   * retained terminal runs. Ownership is runtime attachment, so it is never read from a
   * display label or from persisted state.
   */
  entries: () => readonly LoopActivityEntry[];
  /** False once the producer can no longer answer for its own workspace. */
  available?: () => boolean;
}

/**
 * Publishes a scoped loop inventory and tells consumers when it changed.
 *
 * Runs another session owns are excluded rather than reported as someone else's work, and
 * a producer that cannot answer reports `unavailable` instead of an empty list, so a
 * consumer never reads a failure as "nothing is running".
 */
export class LoopActivityPublisher {
  private readonly listeners = new Set<() => void>();
  private revision = 0;

  constructor(private readonly options: LoopActivityPublisherOptions) {}

  snapshot(scope: LoopActivityScope): LoopActivitySnapshot {
    try {
      if (this.options.available && !this.options.available()) return this.unavailable(scope);
      const owned = this.options
        .entries()
        .filter((entry) => entry.owner === scope.sessionId)
        .map((entry) => entry.state);
      return projectLoopActivity(scope, this.revision, owned);
    } catch {
      return this.unavailable(scope);
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Announce a change to the retained runs. A failing consumer never reaches the producer. */
  changed(): void {
    this.revision += 1;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        /* Consumer failures are the consumer's problem. */
      }
    }
  }

  dispose(): void {
    this.listeners.clear();
  }

  private unavailable(scope: LoopActivityScope): LoopActivitySnapshot {
    return {
      version: 1,
      scope: { ...scope },
      revision: this.revision,
      availability: "unavailable",
      complete: false,
      runs: [],
    };
  }
}
