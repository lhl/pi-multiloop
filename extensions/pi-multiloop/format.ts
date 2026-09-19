import { type RunAccounting, accountedTokens } from "./state.js";

export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.trunc(totalSeconds));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.trunc(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.trunc(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours >= 24) return `${Math.trunc(hours / 24)}d ${hours % 24}h ${remainingMinutes}m`;
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}

export function formatTokenCount(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${trimDecimal(value / 1_000_000)}M`;
  if (abs >= 1_000) return `${trimDecimal(value / 1_000)}K`;
  return String(Math.trunc(value));
}

function trimDecimal(value: number): string {
  const rounded = value.toFixed(1);
  return rounded.endsWith(".0") ? rounded.slice(0, -2) : rounded;
}

/**
 * One-line work summary for the user. Callers must not put this in a prompt.
 */
export function formatAccounting(accounting: RunAccounting, tokenBudget?: number): string {
  const tokens = accountedTokens(accounting);
  const budget = tokenBudget === undefined ? "" : ` of ${formatTokenCount(tokenBudget)}`;
  return [
    `time ${formatDuration(accounting.activeSeconds)}`,
    `${accounting.turns} turn${accounting.turns === 1 ? "" : "s"}`,
    `${accounting.toolCalls} tool call${accounting.toolCalls === 1 ? "" : "s"}`,
    `${formatTokenCount(tokens)}${budget} tokens`,
  ].join(", ");
}
