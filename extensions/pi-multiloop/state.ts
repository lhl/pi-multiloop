import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { type LaneId, laneDir, ensureLaneDir } from "./lanes.js";

export interface VerificationCheck {
  name: string;
  passed: boolean;
  kind?: string;
  command?: string;
  prompt?: string;
  evidence?: string;
}

export type ResultAction = "keep" | "revert" | "log" | "skip";
export type EscalationType = "refine" | "pivot" | "stop";

export interface IterationResult {
  iteration: number;
  timestamp: string;
  action: ResultAction;
  metric?: number;
  baseline?: number;
  delta?: number;
  confidence?: "high" | "medium" | "low";
  hypothesis?: string;
  changes?: string;
  reason?: string;
  shouldEscalate?: boolean;
  escalationType?: EscalationType;
  error?: string;
  measurements?: number[];
  checks?: VerificationCheck[];
  acceptancePassed?: boolean;
  acceptanceReason?: string;
}

export interface ActiveIteration {
  iteration: number;
  phase: "started" | "measured";
  startedAt: string;
  hypothesis?: string;
  changes?: string;
  measurements?: number[];
  metric?: number;
  checks?: VerificationCheck[];
  acceptancePassed?: boolean;
  acceptanceReason?: string;
  recommendedAction?: "keep" | "revert" | "log";
  measuredAt?: string;
}

export interface LoopState {
  lane: string;
  runTag: string;
  mode: string;
  iteration: number;
  baseline: number | null;
  currentMetric: number | null;
  bestMetric: number | null;
  consecutiveFailures: number;
  pivotCount: number;
  status: "running" | "paused" | "completed" | "stopped" | "archived";
  verifyCommand: string;
  guardCommand?: string;
  promptVerifier?: string;
  acceptancePolicy?: string;
  metricName?: string;
  metricDirection: "lower" | "higher";
  scope?: string;
  goal?: string;
  activeIteration?: ActiveIteration;
  startedAt: string;
  lastUpdated: string;
  config: Record<string, unknown>;
}

const RESULTS_FILE = "results.jsonl";
const STATE_FILE = "state.json";
const LESSONS_FILE = "lessons.md";

function resultsPath(cwd: string, id: LaneId): string {
  return join(laneDir(cwd, id), RESULTS_FILE);
}

function statePath(cwd: string, id: LaneId): string {
  return join(laneDir(cwd, id), STATE_FILE);
}

function lessonsPath(cwd: string, id: LaneId): string {
  return join(laneDir(cwd, id), LESSONS_FILE);
}

export function appendResult(
  cwd: string,
  id: LaneId,
  result: IterationResult
): void {
  ensureLaneDir(cwd, id);
  appendFileSync(resultsPath(cwd, id), JSON.stringify(result) + "\n");
}

export function readResults(cwd: string, id: LaneId): IterationResult[] {
  const path = resultsPath(cwd, id);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function readResultsSince(
  cwd: string,
  id: LaneId,
  afterIteration: number
): IterationResult[] {
  return readResults(cwd, id).filter((r) => r.iteration > afterIteration);
}

export function saveState(cwd: string, id: LaneId, state: LoopState): void {
  ensureLaneDir(cwd, id);
  state.lastUpdated = new Date().toISOString();
  writeFileSync(statePath(cwd, id), JSON.stringify(state, null, 2) + "\n");
}

export function loadState(cwd: string, id: LaneId): LoopState | null {
  const path = statePath(cwd, id);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8"));
}

export function reconstructState(cwd: string, id: LaneId): LoopState | null {
  const state = loadState(cwd, id);
  if (!state) return null;

  const results = readResults(cwd, id);
  if (results.length === 0) {
    if (state.activeIteration && state.activeIteration.iteration <= state.iteration) {
      delete state.activeIteration;
    }
    return state;
  }

  const last = results[results.length - 1];
  state.iteration = last.iteration;
  if (state.activeIteration && state.activeIteration.iteration <= state.iteration) {
    delete state.activeIteration;
  }

  let currentMetric = state.baseline ?? state.currentMetric;
  let bestMetric = state.baseline ?? state.bestMetric;
  let consecutiveFailures = 0;
  let replayedPivotCount = 0;
  let sawEscalationMetadata = false;

  for (const result of results) {
    if (result.escalationType) {
      sawEscalationMetadata = true;
    }

    if (result.action === "keep") {
      consecutiveFailures = 0;
      if (result.metric !== undefined) {
        currentMetric = result.metric;
        bestMetric = bestMetric === null
          ? result.metric
          : state.metricDirection === "lower"
            ? Math.min(bestMetric, result.metric)
            : Math.max(bestMetric, result.metric);
      }
      continue;
    }

    if (result.action === "revert") {
      consecutiveFailures++;
      if (result.escalationType === "pivot") {
        replayedPivotCount++;
        consecutiveFailures = 0;
      } else if (result.escalationType === "stop") {
        state.status = "stopped";
      }
      continue;
    }

    if (result.action === "log" && result.metric !== undefined) {
      currentMetric = result.metric;
    }
  }

  state.currentMetric = currentMetric;
  state.bestMetric = bestMetric;
  state.consecutiveFailures = consecutiveFailures;
  if (sawEscalationMetadata) {
    state.pivotCount = Math.max(state.pivotCount ?? 0, replayedPivotCount);
  }

  return state;
}

export function appendLesson(
  cwd: string,
  id: LaneId,
  lesson: string
): void {
  ensureLaneDir(cwd, id);
  const path = lessonsPath(cwd, id);
  const entry = `- [${new Date().toISOString()}] ${lesson}\n`;
  appendFileSync(path, entry);
}

export function readLessons(cwd: string, id: LaneId): string {
  const path = lessonsPath(cwd, id);
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf-8");
}

export function createInitialState(
  id: LaneId,
  mode: string,
  verifyCommand: string,
  options: {
    guardCommand?: string;
    promptVerifier?: string;
    acceptancePolicy?: string;
    metricName?: string;
    metricDirection?: "lower" | "higher";
    scope?: string;
    goal?: string;
    config?: Record<string, unknown>;
  } = {}
): LoopState {
  return {
    lane: id.lane,
    runTag: id.runTag,
    mode,
    iteration: 0,
    baseline: null,
    currentMetric: null,
    bestMetric: null,
    consecutiveFailures: 0,
    pivotCount: 0,
    status: "running",
    verifyCommand,
    guardCommand: options.guardCommand,
    promptVerifier: options.promptVerifier,
    acceptancePolicy: options.acceptancePolicy,
    metricName: options.metricName,
    metricDirection: options.metricDirection ?? "lower",
    scope: options.scope,
    goal: options.goal,
    startedAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
    config: options.config ?? {},
  };
}
