import { Text } from "@earendil-works/pi-tui";
import { formatDuration, formatTokenCount } from "./format.js";
import { type LoopState, type ResultAction, type RunAccounting, accountedTokens, isQuickGoal, readAccounting } from "./state.js";

/**
 * Session entry type for the durable end-of-run card.
 *
 * The card is written with `pi.appendEntry`, so it renders in the transcript
 * for the user and never enters model context. Everything on it is work
 * accounting, which must not reach the model.
 */
export const RUN_SUMMARY_ENTRY = "multiloop-run-summary";

export type RunOutcome = "complete" | "stopped" | "paused";

export interface RunSummaryCounters {
  keeps: number;
  reverts: number;
  logs: number;
  crashes: number;
  blocked: number;
}

export interface RunSummary {
  outcome: RunOutcome;
  /** Why the run ended or held, when the user did not ask for it directly. */
  reason?: string;
  lane: string;
  runTag: string;
  mode: string;
  kind: "goal" | "measured";
  goal?: string;
  startedAt: string;
  finishedAt: string;
  accounting: RunAccounting;
  tokenBudget?: number;
  /** Recorded steps for a goal, or iterations for a measured run. */
  steps: number;
  counters: RunSummaryCounters;
  /** Measured runs: the metric the run tracked, when one was named. */
  metricName?: string;
  /** Measured runs: the metric recorded before the run started. */
  baseline?: number | null;
  /** Measured runs: the best value the run reached. */
  bestMetric?: number | null;
  /** Measured runs: how the last recorded iteration was accepted. */
  lastAction?: ResultAction | null;
  /** The command that continues the run, when one exists. */
  hint?: string;
}

export interface RunSummaryDetail {
  reason?: string;
  hint?: string;
}

export function buildRunSummary(
  state: LoopState,
  outcome: RunOutcome,
  detail: RunSummaryDetail = {}
): RunSummary {
  return {
    outcome,
    reason: detail.reason,
    lane: state.lane,
    runTag: state.runTag,
    mode: state.mode,
    kind: isQuickGoal(state) ? "goal" : "measured",
    goal: state.goal,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt ?? new Date().toISOString(),
    accounting: readAccounting(state),
    tokenBudget: state.tokenBudget,
    steps: state.iteration,
    metricName: state.metricName,
    baseline: state.baseline,
    bestMetric: state.bestMetric,
    lastAction: state.lastAction,
    counters: {
      keeps: state.keeps ?? 0,
      reverts: state.reverts ?? 0,
      logs: state.logs ?? 0,
      crashes: state.crashes ?? 0,
      blocked: state.blocked ?? 0,
    },
    hint: detail.hint ?? defaultHint(state, outcome),
  };
}

/** A holding status always names the command that continues the run. */
function defaultHint(state: LoopState, outcome: RunOutcome): string | undefined {
  if (outcome === "complete") return undefined;
  const command = isQuickGoal(state) ? "/goal resume" : "/multiloop resume";
  return `Resume with ${command} ${state.lane}/${state.runTag}.`;
}

const OUTCOME_LABELS: Record<RunOutcome, Record<RunSummary["kind"], string>> = {
  complete: { goal: "Goal complete", measured: "Run complete" },
  stopped: { goal: "Goal stopped", measured: "Run stopped" },
  paused: { goal: "Goal paused", measured: "Run paused" },
};

export interface RunSummaryFormatOptions {
  /** Overrides stamp rendering. Tests pass a fixed formatter. */
  formatStamp?: (iso: string, includeDate: boolean) => string;
}

export function formatRunSummary(summary: RunSummary, options: RunSummaryFormatOptions = {}): string {
  const formatStamp = options.formatStamp ?? formatLocalStamp;
  const sameDay = isSameLocalDay(summary.startedAt, summary.finishedAt);
  const label = OUTCOME_LABELS[summary.outcome][summary.kind];
  const lines = [
    `${label}${summary.reason ? ` (${summary.reason})` : ""} · ${summary.lane}/${summary.runTag}`,
  ];
  if (summary.goal) lines.push(`  ${summary.goal}`);
  lines.push(`  ${formatStampRange(summary, formatStamp, sameDay)}`);
  lines.push(...formatWorkLines(summary).map((line) => `  ${line}`));
  if (summary.hint) lines.push(`  ${summary.hint}`);
  return lines.join("\n");
}

function formatStampRange(
  summary: RunSummary,
  formatStamp: (iso: string, includeDate: boolean) => string,
  sameDay: boolean
): string {
  const stamps = `${formatStamp(summary.startedAt, !sameDay)} → ${formatStamp(summary.finishedAt, !sameDay)}`;
  const elapsed = wallSeconds(summary.startedAt, summary.finishedAt);
  if (elapsed === undefined) return stamps;
  const active = summary.accounting.activeSeconds;
  const activeLabel = active > 0 ? ` (${formatDuration(active)} active)` : "";
  return `${stamps} · ${formatDuration(elapsed)} elapsed${activeLabel}`;
}

function formatWorkLines(summary: RunSummary): string[] {
  const accounting = summary.accounting;
  const turns = `${accounting.turns} turn${accounting.turns === 1 ? "" : "s"}`;
  const toolCalls = `${accounting.toolCalls} tool call${accounting.toolCalls === 1 ? "" : "s"}`;
  const budget = summary.tokenBudget === undefined ? "" : ` of ${formatTokenCount(summary.tokenBudget)}`;
  const tokens = `${formatTokenCount(accountedTokens(accounting))}${budget} tokens`;

  if (summary.kind === "goal") {
    return [
      [`${summary.steps} step${summary.steps === 1 ? "" : "s"}`, turns, toolCalls, tokens].join(" · "),
    ];
  }

  const counters = formatCounters(summary.counters);
  const progress = [
    `mode ${summary.mode}`,
    `${summary.steps} iteration${summary.steps === 1 ? "" : "s"}`,
    counters,
  ].filter((part): part is string => Boolean(part));
  const metric = formatMetricLine(summary);
  return [
    ...(metric ? [metric] : []),
    progress.join(" · "),
    [turns, toolCalls, tokens].join(" · "),
  ];
}

const LAST_ACTION_LABELS: Record<ResultAction, string> = {
  keep: "kept",
  revert: "reverted",
  log: "logged",
  skip: "skipped",
  crash: "crashed",
  blocked: "blocked",
};

/**
 * What the run measured and how its last iteration was accepted. A goal has no
 * metric, and a measured run that never recorded one keeps the card it had.
 */
function formatMetricLine(summary: RunSummary): string | undefined {
  if (summary.kind !== "measured") return undefined;
  const best = summary.bestMetric;
  if (best === null || best === undefined) return undefined;
  const label = summary.metricName ? `metric ${summary.metricName}` : "metric";
  const baseline = summary.baseline;
  const parts = [
    baseline !== null && baseline !== undefined
      ? `${label}: ${best} best (baseline ${baseline})`
      : `${label}: ${best} best`,
  ];
  const action = summary.lastAction ? LAST_ACTION_LABELS[summary.lastAction] : undefined;
  if (action) parts.push(`last iteration ${action}`);
  return parts.join(" · ");
}

function formatCounters(counters: RunSummaryCounters): string | undefined {
  const labels: Array<[keyof RunSummaryCounters, string]> = [
    ["keeps", "kept"],
    ["reverts", "reverted"],
    ["logs", "logged"],
    ["crashes", "crashed"],
    ["blocked", "blocked"],
  ];
  const parts = labels
    .filter(([key]) => counters[key] > 0)
    .map(([key, label]) => `${counters[key]} ${label}`);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

/** Wall-clock seconds between two stamps, or undefined when either is unreadable. */
export function wallSeconds(startedAt: string, finishedAt: string): number | undefined {
  const start = Date.parse(startedAt);
  const finish = Date.parse(finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(finish)) return undefined;
  return Math.max(0, Math.round((finish - start) / 1000));
}

function isSameLocalDay(startedAt: string, finishedAt: string): boolean {
  const start = new Date(startedAt);
  const finish = new Date(finishedAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(finish.getTime())) return true;
  return (
    start.getFullYear() === finish.getFullYear() &&
    start.getMonth() === finish.getMonth() &&
    start.getDate() === finish.getDate()
  );
}

function formatLocalStamp(iso: string, includeDate: boolean): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (!includeDate) return time;
  const day = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${day}, ${time}`;
}

export interface RunSummaryTheme {
  fg?: (name: string, text: string) => string;
  bold?: (text: string) => string;
}

function themeFg(theme: RunSummaryTheme, name: string, text: string): string {
  try {
    return theme.fg?.(name, text) ?? text;
  } catch {
    return text;
  }
}

function themeBold(theme: RunSummaryTheme, text: string): string {
  try {
    return theme.bold?.(text) ?? text;
  } catch {
    return text;
  }
}

export function colorizeRunSummary(content: string, theme: RunSummaryTheme): string {
  const accent = (text: string) => themeFg(theme, "accent", text);
  const muted = (text: string) => themeFg(theme, "muted", text);
  const command = (text: string) => themeFg(theme, "syntaxFunction", text);
  return content
    .split("\n")
    .map((line, index) => {
      if (index === 0) return accent(themeBold(theme, line));
      if (line.startsWith("  ") && line.includes(" → ")) return muted(line);
      if (/^\s+(Resume|Continue|Retry)\b/.test(line)) return command(line);
      return line;
    })
    .join("\n");
}

export function runSummaryComponent(summary: RunSummary, theme: RunSummaryTheme): Text {
  return new Text(colorizeRunSummary(formatRunSummary(summary), theme), 0, 0);
}

type EntryRendererHost = {
  registerEntryRenderer?: (
    customType: string,
    renderer: (entry: { data?: unknown }, options: { expanded: boolean }, theme: unknown) => unknown
  ) => void;
};

/** Entry renderers arrived in Pi 0.80.4; older hosts get the notification fallback. */
export function supportsRunSummaryCard(pi: unknown): boolean {
  return typeof (pi as EntryRendererHost | undefined)?.registerEntryRenderer === "function";
}

export function registerRunSummaryRenderer(pi: unknown): boolean {
  const host = pi as EntryRendererHost;
  if (typeof host.registerEntryRenderer !== "function") return false;
  host.registerEntryRenderer(RUN_SUMMARY_ENTRY, (entry, _options, theme) =>
    runSummaryComponent(entry.data as RunSummary, theme as RunSummaryTheme)
  );
  return true;
}
