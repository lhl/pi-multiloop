import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { type LaneId, laneDir, ensureLaneDir } from "./lanes.js";

export interface IterationResult {
  iteration: number;
  timestamp: string;
  action: "keep" | "revert" | "log" | "skip";
  metric?: number;
  baseline?: number;
  delta?: number;
  confidence?: "high" | "medium" | "low";
  hypothesis?: string;
  changes?: string;
  error?: string;
  measurements?: number[];
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
  status: "running" | "paused" | "completed" | "stopped";
  verifyCommand: string;
  guardCommand?: string;
  metricName?: string;
  metricDirection: "lower" | "higher";
  scope?: string;
  goal?: string;
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
  if (results.length === 0) return state;

  const last = results[results.length - 1];
  state.iteration = last.iteration;
  if (last.metric !== undefined) {
    state.currentMetric = last.metric;
  }

  let consecutiveFailures = 0;
  for (let i = results.length - 1; i >= 0; i--) {
    if (results[i].action === "revert") {
      consecutiveFailures++;
    } else {
      break;
    }
  }
  state.consecutiveFailures = consecutiveFailures;

  const kept = results.filter((r) => r.action === "keep" && r.metric !== undefined);
  if (kept.length > 0) {
    const best = state.metricDirection === "lower"
      ? Math.min(...kept.map((r) => r.metric!))
      : Math.max(...kept.map((r) => r.metric!));
    state.bestMetric = best;
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
    metricName: options.metricName,
    metricDirection: options.metricDirection ?? "lower",
    scope: options.scope,
    goal: options.goal,
    startedAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
    config: options.config ?? {},
  };
}
