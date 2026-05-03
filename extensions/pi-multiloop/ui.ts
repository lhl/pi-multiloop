import type { LoopState } from "./state.js";
import { confidenceLabel } from "./metrics.js";

export interface DashboardRow {
  lane: string;
  runTag: string;
  mode: string;
  iteration: number;
  status: string;
  metric: string;
  best: string;
  delta: string;
  confidence: string;
  failures: number;
  pivots: number;
}

export function buildDashboardRows(states: LoopState[]): DashboardRow[] {
  return states.map((s) => ({
    lane: s.lane,
    runTag: s.runTag,
    mode: s.mode,
    iteration: s.iteration,
    status: s.status,
    metric: s.currentMetric !== null ? s.currentMetric.toFixed(4) : "—",
    best: s.bestMetric !== null ? s.bestMetric.toFixed(4) : "—",
    delta:
      s.baseline !== null && s.currentMetric !== null
        ? formatPct(s.baseline, s.currentMetric, s.metricDirection)
        : "—",
    confidence: "—",
    failures: s.consecutiveFailures,
    pivots: s.pivotCount,
  }));
}

function formatPct(
  baseline: number,
  current: number,
  direction: "lower" | "higher"
): string {
  const diff = current - baseline;
  const pct = ((diff / Math.abs(baseline)) * 100).toFixed(1);
  const improved =
    direction === "lower" ? diff < 0 : diff > 0;
  return `${diff >= 0 ? "+" : ""}${pct}%${improved ? " +" : ""}`;
}

export function formatDashboardText(rows: DashboardRow[]): string[] {
  if (rows.length === 0) return ["No active loops."];

  const lines: string[] = [];
  lines.push(
    padRight("LANE", 12) +
      padRight("MODE", 10) +
      padRight("ITER", 6) +
      padRight("STATUS", 10) +
      padRight("METRIC", 12) +
      padRight("BEST", 12) +
      padRight("DELTA", 10) +
      padRight("FAIL", 5) +
      "PIV"
  );
  lines.push("─".repeat(77));

  for (const r of rows) {
    lines.push(
      padRight(r.lane, 12) +
        padRight(r.mode, 10) +
        padRight(String(r.iteration), 6) +
        padRight(r.status, 10) +
        padRight(r.metric, 12) +
        padRight(r.best, 12) +
        padRight(r.delta, 10) +
        padRight(String(r.failures), 5) +
        String(r.pivots)
    );
  }

  return lines;
}

function padRight(str: string, len: number): string {
  return str.length >= len ? str.slice(0, len) : str + " ".repeat(len - str.length);
}

export function formatLoopSummary(state: LoopState): string[] {
  const lines: string[] = [];
  lines.push(`Loop: ${state.lane}/${state.runTag}`);
  lines.push(`Mode: ${state.mode} | Status: ${state.status}`);
  lines.push(`Iteration: ${state.iteration}`);

  if (state.goal) lines.push(`Goal: ${state.goal}`);

  if (state.baseline !== null) {
    lines.push(`Baseline: ${state.baseline}`);
    if (state.currentMetric !== null) {
      lines.push(`Current: ${state.currentMetric}`);
      const pct = formatPct(state.baseline, state.currentMetric, state.metricDirection);
      lines.push(`Change: ${pct}`);
    }
    if (state.bestMetric !== null) {
      lines.push(`Best: ${state.bestMetric}`);
    }
  }

  if (state.consecutiveFailures > 0) {
    lines.push(`Consecutive failures: ${state.consecutiveFailures}`);
  }
  if (state.pivotCount > 0) {
    lines.push(`Pivots: ${state.pivotCount}/2`);
  }

  return lines;
}
