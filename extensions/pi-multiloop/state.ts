import { readFileSync, writeFileSync, appendFileSync, existsSync, openSync, closeSync, fsyncSync, renameSync, rmSync } from "node:fs";
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

export type ResultAction = "keep" | "revert" | "log" | "skip" | "crash" | "blocked";
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
  keeps: number;
  reverts: number;
  logs: number;
  crashes: number;
  blocked: number;
  lastAction: ResultAction | null;
  lastActionAt?: string;
  status: "running" | "paused" | "completed" | "stopped" | "archived";
  verifyCommand: string;
  guardCommand?: string;
  promptVerifier?: string;
  acceptancePolicy?: string;
  metricName?: string;
  metricDirection: "lower" | "higher";
  acceptanceMode: "log" | "keep-revert";
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

/**
 * Codes that mean "this platform or filesystem cannot flush a directory
 * handle", as opposed to "the flush failed for a real reason".
 *
 * Windows always lands here: `fsyncSync()` on an opened directory raises
 * `EPERM`, because NTFS exposes no directory-handle flush and journals
 * metadata itself. Network and stacked filesystems (SMB/NFS/overlay/fuse)
 * can also answer `ENOTSUP` or `EINVAL` on some hosts.
 */
const DIRECTORY_FSYNC_UNSUPPORTED_CODES = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EINVAL"]);

export function isDirectoryFsyncUnsupported(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && DIRECTORY_FSYNC_UNSUPPORTED_CODES.has(code);
}

/**
 * Flush a directory after an atomic rename so the new name survives a crash.
 *
 * Durability of the *contents* comes from the file fsync in `saveState`; this
 * step only makes the rename itself durable. Where the platform has no
 * directory-flush primitive we return "unsupported" without failing the write.
 * Any other error on the directory path still throws, and a file fsync failure
 * always throws, so a state write is never reported as durable when its bytes
 * did not reach disk.
 *
 * `platform` is a parameter so the Windows branch is testable off-Windows.
 */
export function flushDirectoryForRename(
  dir: string,
  platform: NodeJS.Platform = process.platform
): "flushed" | "unsupported" {
  // Windows has no directory flush primitive; NTFS metadata journaling covers
  // the rename. Attempting it costs a guaranteed EPERM on every save.
  if (platform === "win32") return "unsupported";

  let fd: number;
  try {
    fd = openSync(dir, "r");
  } catch (err) {
    if (isDirectoryFsyncUnsupported(err)) return "unsupported";
    throw err;
  }
  try {
    fsyncSync(fd);
  } catch (err) {
    if (isDirectoryFsyncUnsupported(err)) return "unsupported";
    throw err;
  } finally {
    closeSync(fd);
  }
  return "flushed";
}

function resultsPath(cwd: string, id: LaneId): string {
  return join(laneDir(cwd, id), RESULTS_FILE);
}

function statePath(cwd: string, id: LaneId): string {
  return join(laneDir(cwd, id), STATE_FILE);
}

function lessonsPath(cwd: string, id: LaneId): string {
  return join(laneDir(cwd, id), LESSONS_FILE);
}

export function resetActionCounters(state: LoopState): void {
  state.keeps = 0;
  state.reverts = 0;
  state.logs = 0;
  state.crashes = 0;
  state.blocked = 0;
  state.lastAction = null;
  delete state.lastActionAt;
}

export function recordActionCounter(
  state: LoopState,
  action: ResultAction,
  timestamp: string = new Date().toISOString()
): void {
  state.keeps ??= 0;
  state.reverts ??= 0;
  state.logs ??= 0;
  state.crashes ??= 0;
  state.blocked ??= 0;

  switch (action) {
    case "keep": state.keeps++; break;
    case "revert": state.reverts++; break;
    case "log": state.logs++; break;
    case "crash": state.crashes++; break;
    case "blocked": state.blocked++; break;
    case "skip": break;
  }
  state.lastAction = action;
  state.lastActionAt = timestamp;
}

export function formatActionCounters(
  state: Pick<LoopState, "keeps" | "reverts" | "logs" | "crashes" | "blocked" | "lastAction" | "lastActionAt">
): string {
  const parts = [
    `keeps=${state.keeps ?? 0}`,
    `reverts=${state.reverts ?? 0}`,
    `logs=${state.logs ?? 0}`,
    `crashes=${state.crashes ?? 0}`,
    `blocked=${state.blocked ?? 0}`,
  ];
  if (state.lastAction) {
    parts.push(`last=${state.lastAction}${state.lastActionAt ? ` at ${state.lastActionAt}` : ""}`);
  }
  return parts.join(", ");
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
  const dir = ensureLaneDir(cwd, id);
  state.lastUpdated = new Date().toISOString();

  const finalPath = statePath(cwd, id);
  const tmpPath = join(dir, `.state.json.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  const data = JSON.stringify(state, null, 2) + "\n";
  let fileFd: number | undefined;

  try {
    fileFd = openSync(tmpPath, "w");
    writeFileSync(fileFd, data);
    fsyncSync(fileFd);
    closeSync(fileFd);
    fileFd = undefined;

    renameSync(tmpPath, finalPath);

    flushDirectoryForRename(dir);
  } catch (err) {
    if (fileFd !== undefined) closeSync(fileFd);
    rmSync(tmpPath, { force: true });
    throw err;
  }
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
    state.keeps ??= 0;
    state.reverts ??= 0;
    state.logs ??= 0;
    state.crashes ??= 0;
    state.blocked ??= 0;
    state.lastAction ??= null;
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
  resetActionCounters(state);

  for (const result of results) {
    recordActionCounter(state, result.action, result.timestamp);
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
    acceptanceMode?: "log" | "keep-revert";
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
    keeps: 0,
    reverts: 0,
    logs: 0,
    crashes: 0,
    blocked: 0,
    lastAction: null,
    status: "running",
    verifyCommand,
    guardCommand: options.guardCommand,
    promptVerifier: options.promptVerifier,
    acceptancePolicy: options.acceptancePolicy,
    metricName: options.metricName,
    metricDirection: options.metricDirection ?? "lower",
    acceptanceMode: options.acceptanceMode ?? (mode === "optimize" ? "keep-revert" : "log"),
    scope: options.scope,
    goal: options.goal,
    startedAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
    config: options.config ?? {},
  };
}
