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
  metric?: string;
}

export interface Registry {
  version: 1;
  loops: RegistryEntry[];
}

const REGISTRY_FILE = ".autoloop-registry.json";
const STATE_BASE = "state/autoloop";

export function laneDir(cwd: string, id: LaneId): string {
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
  writeFileSync(registryPath(cwd), JSON.stringify(registry, null, 2) + "\n");
}

export function ensureLaneDir(cwd: string, id: LaneId): string {
  const dir = laneDir(cwd, id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function registerLoop(cwd: string, entry: RegistryEntry): void {
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
  status: RegistryEntry["status"]
): void {
  const registry = readRegistry(cwd);
  const entry = registry.loops.find(
    (l) => l.lane === id.lane && l.runTag === id.runTag
  );
  if (entry) {
    entry.status = status;
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
  const base = archiveBase ?? resolve(cwd, "artifacts/autoloop-archive");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = join(base, `${timestamp}-${id.lane}-${id.runTag}`);
  mkdirSync(dest, { recursive: true });
  renameSync(src, dest);
  updateLoopStatus(cwd, id, "archived");
  return dest;
}

export function generateRunTag(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  const seq = now.toISOString().slice(11, 19).replace(/:/g, "");
  return `run-${date}-${seq}`;
}

export function parseLaneId(input: string): LaneId | null {
  const parts = input.split("/");
  if (parts.length === 2 && parts[0] && parts[1]) {
    return { lane: parts[0], runTag: parts[1] };
  }
  return null;
}

export function formatLaneId(id: LaneId): string {
  return `${id.lane}/${id.runTag}`;
}
