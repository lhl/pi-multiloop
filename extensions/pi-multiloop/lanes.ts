import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";

export interface LaneId {
  lane: string;
  runTag: string;
}

export interface RegistryEntry {
  lane: string;
  runTag: string;
  mode: string;
  status: "active" | "paused" | "completed" | "archived";
  startedAt: string;
  stateDir: string;
  verifyCommand?: string;
  guardCommand?: string;
  promptVerifier?: string;
  acceptancePolicy?: string;
  metric?: string;
}

export interface Registry {
  version: 1;
  loops: RegistryEntry[];
}

const BASE_DIR = ".multiloop";
const REGISTRY_FILE = `${BASE_DIR}/registry.json`;
const STATE_BASE = `${BASE_DIR}/active`;
const ID_PART_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function validateLaneId(id: LaneId): string | null {
  if (!ID_PART_PATTERN.test(id.lane)) {
    return `Invalid lane "${id.lane}". Use 1-64 letters, numbers, dots, underscores, or hyphens, starting with a letter or number.`;
  }
  if (!ID_PART_PATTERN.test(id.runTag)) {
    return `Invalid run tag "${id.runTag}". Use 1-64 letters, numbers, dots, underscores, or hyphens, starting with a letter or number.`;
  }
  return null;
}

export function assertValidLaneId(id: LaneId): void {
  const error = validateLaneId(id);
  if (error) throw new Error(error);
}

export function laneDir(cwd: string, id: LaneId): string {
  assertValidLaneId(id);
  return resolve(cwd, STATE_BASE, id.lane, id.runTag);
}

export function registryPath(cwd: string): string {
  return resolve(cwd, REGISTRY_FILE);
}

export function readRegistry(cwd: string): Registry {
  const path = registryPath(cwd);
  if (!existsSync(path)) {
    return { version: 1, loops: [] };
  }
  return JSON.parse(readFileSync(path, "utf-8"));
}

export function writeRegistry(cwd: string, registry: Registry): void {
  mkdirSync(resolve(cwd, BASE_DIR), { recursive: true });
  writeFileSync(registryPath(cwd), JSON.stringify(registry, null, 2) + "\n");
}

export function ensureLaneDir(cwd: string, id: LaneId): string {
  const dir = laneDir(cwd, id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function registerLoop(cwd: string, entry: RegistryEntry): void {
  assertValidLaneId(entry);
  const registry = readRegistry(cwd);
  const existing = registry.loops.findIndex(
    (l) => l.lane === entry.lane && l.runTag === entry.runTag
  );
  if (existing >= 0) {
    registry.loops[existing] = entry;
  } else {
    registry.loops.push(entry);
  }
  writeRegistry(cwd, registry);
}

export function updateLoopStatus(
  cwd: string,
  id: LaneId,
  status: RegistryEntry["status"],
  stateDir?: string
): void {
  const registry = readRegistry(cwd);
  const entry = registry.loops.find(
    (l) => l.lane === id.lane && l.runTag === id.runTag
  );
  if (entry) {
    entry.status = status;
    if (stateDir !== undefined) {
      entry.stateDir = stateDir;
    }
    writeRegistry(cwd, registry);
  }
}

export function getActiveLoops(cwd: string): RegistryEntry[] {
  return readRegistry(cwd).loops.filter((l) => l.status === "active");
}

export function getLoop(cwd: string, id: LaneId): RegistryEntry | undefined {
  return readRegistry(cwd).loops.find(
    (l) => l.lane === id.lane && l.runTag === id.runTag
  );
}

export function removeLoop(cwd: string, id: LaneId): void {
  const registry = readRegistry(cwd);
  registry.loops = registry.loops.filter(
    (l) => !(l.lane === id.lane && l.runTag === id.runTag)
  );
  writeRegistry(cwd, registry);
}

export function archiveLoop(
  cwd: string,
  id: LaneId,
  archiveBase?: string
): string {
  const src = laneDir(cwd, id);
  const base = archiveBase ?? resolve(cwd, `${BASE_DIR}/archive`);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = join(base, `${timestamp}-${id.lane}-${id.runTag}`);
  mkdirSync(dest, { recursive: true });
  renameSync(src, dest);
  const stateFile = join(dest, "state.json");
  if (existsSync(stateFile)) {
    const state = JSON.parse(readFileSync(stateFile, "utf-8"));
    state.status = "archived";
    writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n");
  }
  const relDest = dest.startsWith(cwd) ? dest.slice(cwd.length + 1) : dest;
  updateLoopStatus(cwd, id, "archived", relDest);
  return dest;
}

export function deleteLaneDirs(cwd: string, id: LaneId): void {
  const dir = laneDir(cwd, id);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true });
  }
  removeLoop(cwd, id);
}

export function generateRunTag(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  const seq = now.toISOString().slice(11, 19).replace(/:/g, "");
  return `run-${date}-${seq}`;
}

export function parseLaneId(input: string): LaneId | null {
  const parts = input.trim().split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null;
  }

  const id = { lane: parts[0], runTag: parts[1] };
  return validateLaneId(id) ? null : id;
}

export function formatLaneId(id: LaneId): string {
  return `${id.lane}/${id.runTag}`;
}
