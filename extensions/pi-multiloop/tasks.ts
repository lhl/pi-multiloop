/**
 * tasks.ts — Locate, read, and format the pi-tasks store without depending on
 * @tintinweb/pi-tasks at runtime.
 *
 * pi-tasks stores its task list as JSON on disk at one of:
 *
 *   1. process.env.PI_TASKS = "off"        → no store, no integration
 *   2. process.env.PI_TASKS = "/abs/path"  → that path
 *   3. process.env.PI_TASKS = "./rel/path" → resolved against cwd
 *   4. process.env.PI_TASKS = "name.json"  → used as-is
 *   5. .pi/tasks-config.json `taskScope`:
 *      - "memory"  → no store
 *      - "project" → cwd/.pi/tasks/tasks.json
 *      - "session" (default) → cwd/.pi/tasks/tasks-<sessionId>.json
 *
 * Schema mirrors @tintinweb/pi-tasks/src/types.ts. We read but never write.
 *
 * A quick goal uses this for two things: injecting live task state into its
 * continuation prompt, and refusing completion while tasks remain open.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";


export type TaskStatus = "pending" | "in_progress" | "completed";
export type TasksAutoMode = "off" | "cascade" | "auto";

export type TaskSnapshotItem = {
  id: string;
  subject: string;
  status: TaskStatus;
  openBlockers: string[];
};

export type TaskSnapshot = {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
  blocked: number;
  /** Open tasks (pending or in_progress), sorted by id ascending. */
  open: TaskSnapshotItem[];
};

export type TasksDiscovery = {
  /** Absolute path to the discovered pi-tasks json file, or undefined. */
  storePath: string | undefined;
  /** Effective auto-mode read from cwd/.pi/tasks-config.json. */
  autoMode: TasksAutoMode;
};

const TASKS_CONFIG_REL = join(".pi", "tasks-config.json");
const PROJECT_TASKS_REL = join(".pi", "tasks", "tasks.json");

export function discoverTasksStore(cwd: string, sessionId: string | undefined): TasksDiscovery {
  const config = loadTasksConfig(cwd);
  const autoMode = resolveAutoMode(config);
  const storePath = resolveStorePath(cwd, sessionId, config);
  return { storePath, autoMode };
}

export function readTaskSnapshot(storePath: string | undefined): TaskSnapshot | null {
  if (storePath === undefined) return null;
  if (!existsSync(storePath)) return null;
  let raw: string;
  try {
    raw = readFileSync(storePath, "utf8");
  } catch {
    return null;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;
  const rawTasks = data["tasks"];
  if (!Array.isArray(rawTasks)) return null;

  const counts = { pending: 0, inProgress: 0, completed: 0, blocked: 0 };
  const open: TaskSnapshotItem[] = [];
  const completedIds = new Set<string>();
  for (const entry of rawTasks) {
    if (!isRecord(entry)) continue;
    if (entry["status"] === "completed" && typeof entry["id"] === "string") {
      completedIds.add(entry["id"]);
    }
  }
  for (const entry of rawTasks) {
    const item = normalizeTask(entry, completedIds);
    if (item === null) continue;
    switch (item.status) {
      case "completed":
        counts.completed += 1;
        break;
      case "in_progress":
        counts.inProgress += 1;
        open.push(item);
        if (item.openBlockers.length > 0) counts.blocked += 1;
        break;
      case "pending":
        counts.pending += 1;
        open.push(item);
        if (item.openBlockers.length > 0) counts.blocked += 1;
        break;
    }
  }
  open.sort((a, b) => compareTaskIds(a.id, b.id));
  return {
    total: counts.pending + counts.inProgress + counts.completed,
    pending: counts.pending,
    inProgress: counts.inProgress,
    completed: counts.completed,
    blocked: counts.blocked,
    open,
  };
}

function normalizeTask(value: unknown, completedIds: Set<string>): TaskSnapshotItem | null {
  if (!isRecord(value)) return null;
  const id = value["id"];
  const subject = value["subject"];
  const status = value["status"];
  if (typeof id !== "string" || typeof subject !== "string") return null;
  if (!isTaskStatus(status)) return null;
  const blockedBy = Array.isArray(value["blockedBy"]) ? value["blockedBy"] : [];
  const openBlockers = blockedBy
    .filter((dep): dep is string => typeof dep === "string")
    .filter((dep) => !completedIds.has(dep));
  return { id, subject, status, openBlockers };
}

function compareTaskIds(a: string, b: string): number {
  const aNum = Number(a);
  const bNum = Number(b);
  const aIsNum = Number.isFinite(aNum);
  const bIsNum = Number.isFinite(bNum);
  if (aIsNum && bIsNum) return aNum - bNum;
  if (aIsNum) return -1;
  if (bIsNum) return 1;
  return a.localeCompare(b);
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return value === "pending" || value === "in_progress" || value === "completed";
}

function resolveStorePath(cwd: string, sessionId: string | undefined, config: TasksConfigShape): string | undefined {
  const env = process.env["PI_TASKS"];
  if (env === "off") return undefined;
  if (env !== undefined && env.length > 0) {
    if (isAbsolute(env)) return env;
    if (env.startsWith(".")) return resolve(cwd, env);
    return env;
  }
  const taskScope = config.taskScope ?? "session";
  if (taskScope === "memory") return undefined;
  if (taskScope === "project") return join(cwd, PROJECT_TASKS_REL);
  if (sessionId === undefined || sessionId.length === 0) return undefined;
  return join(cwd, ".pi", "tasks", `tasks-${sessionId}.json`);
}

function resolveAutoMode(config: TasksConfigShape): TasksAutoMode {
  if (config.autoMode === "cascade" || config.autoMode === "auto" || config.autoMode === "off") {
    return config.autoMode;
  }
  if (config.autoCascade === true) return "cascade";
  return "off";
}

type TasksConfigShape = {
  taskScope?: "memory" | "session" | "project";
  autoCascade?: boolean;
  autoMode?: TasksAutoMode;
};

function loadTasksConfig(cwd: string): TasksConfigShape {
  const configPath = join(cwd, TASKS_CONFIG_REL);
  if (!existsSync(configPath)) return {};
  try {
    const raw = readFileSync(configPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return {};
    const result: TasksConfigShape = {};
    const taskScope = parsed["taskScope"];
    if (taskScope === "memory" || taskScope === "session" || taskScope === "project") {
      result.taskScope = taskScope;
    }
    const autoMode = parsed["autoMode"];
    if (autoMode === "off" || autoMode === "cascade" || autoMode === "auto") {
      result.autoMode = autoMode;
    }
    const autoCascade = parsed["autoCascade"];
    if (typeof autoCascade === "boolean") result.autoCascade = autoCascade;
    return result;
  } catch {
    return {};
  }
}


/* Formatting for prompt injection. The snapshot is wrapped in <task_list> tags
 * inside the untrusted-data section so it reads as live state, not as
 * higher-priority instructions. */

const MAX_LISTED_OPEN_TASKS = 20;
const MAX_SUBJECT_LENGTH = 160;

export function formatTaskListSnapshot(snapshot: TaskSnapshot): string {
  const header = `<task_list total="${snapshot.total}" pending="${snapshot.pending}" in_progress="${snapshot.inProgress}" blocked="${snapshot.blocked}" completed="${snapshot.completed}">`;
  if (snapshot.open.length === 0) {
    return [header, "  (no open tasks)", "</task_list>"].join("\n");
  }
  const head = snapshot.open.slice(0, MAX_LISTED_OPEN_TASKS).map(formatTaskRow);
  const overflow = Math.max(0, snapshot.open.length - MAX_LISTED_OPEN_TASKS);
  const rows = overflow > 0 ? [...head, `  ... and ${overflow} more open task(s)`] : head;
  return [header, ...rows, "</task_list>"].join("\n");
}

function formatTaskRow(item: TaskSnapshot["open"][number]): string {
  const subject = truncateSubject(item.subject);
  const blockedSuffix =
    item.openBlockers.length > 0 ? ` › blocked by ${item.openBlockers.map((id) => `#${id}`).join(", ")}` : "";
  const status = item.status === "in_progress" ? "in_progress" : "pending";
  return `  [#${item.id} ${status}] ${escapeXmlText(subject)}${blockedSuffix}`;
}

function truncateSubject(subject: string): string {
  const flat = subject.replace(/\s+/g, " ").trim();
  if (flat.length <= MAX_SUBJECT_LENGTH) return flat;
  return `${flat.slice(0, MAX_SUBJECT_LENGTH - 1)}…`;
}

function escapeXmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
