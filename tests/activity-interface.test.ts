import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LOOP_ACTIVITY_CHANGED,
  LOOP_ACTIVITY_REQUEST,
  type LoopActivitySnapshot,
} from "../extensions/pi-multiloop/activity.js";
import { vi } from "vitest";

type Register = (typeof import("../extensions/pi-multiloop/index.js"))["default"];

/**
 * The extension keeps one retained inventory per process, which is what a multi-session host
 * needs. Tests therefore load a fresh module instance instead of sharing that inventory.
 */
async function loadExtension(): Promise<Register> {
  vi.resetModules();
  return (await import("../extensions/pi-multiloop/index.js")).default;
}

/** Minimal host: only the surface the extension registration and tools actually touch. */
async function harness() {
  const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const changes: unknown[] = [];
  const events = {
    emit(channel: string, data: unknown) {
      if (channel === LOOP_ACTIVITY_CHANGED) changes.push(data);
      for (const listener of listeners.get(channel) ?? []) listener(data);
    },
    on(channel: string, handler: (data: unknown) => void) {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel)?.add(handler);
      return () => listeners.get(channel)?.delete(handler);
    },
  };
  const pi = {
    on: () => {},
    registerCommand: () => {},
    registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) =>
      tools.set(tool.name, tool),
    registerMessageRenderer: () => {},
    sendMessage: async () => {},
    sendUserMessage: async () => {},
    events,
  };
  const register = await loadExtension();
  register(pi as unknown as Parameters<Register>[0]);
  return { events, tools, changes };
}

type EventBusStub = { emit(channel: string, data: unknown): void; on(channel: string, handler: (data: unknown) => void): () => void };

function context(cwd: string, sessionId: string) {
  return {
    cwd,
    sessionManager: { getSessionId: () => sessionId },
    ui: { setStatus: () => {}, notify: () => {} },
  };
}

function snapshotFor(events: EventBusStub, sessionId: string) {
  let snapshot: LoopActivitySnapshot | undefined;
  events.emit(LOOP_ACTIVITY_REQUEST, {
    version: 1,
    sessionId,
    respond: (value: LoopActivitySnapshot) => {
      snapshot = value;
    },
  });
  return snapshot;
}

let root: string;
let cwd: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-multiloop-activity-"));
  cwd = join(root, "workspace");
  mkdirSync(cwd, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("loop activity interface", () => {
  it("reports a started loop to the session that started it and to no other", async () => {
    const { events, tools } = await harness();
    const ctx = context(cwd, "session-a");
    await tools.get("multiloop_start")?.execute("call-1", { lane: "dev", mode: "dev", goal: "ship" }, undefined, undefined, ctx);

    const mine = snapshotFor(events, "session-a");
    expect(mine?.availability).toBe("available");
    expect(mine?.complete).toBe(true);
    expect(mine?.scope.sessionId).toBe("session-a");
    expect(mine?.runs.map((run) => run.lane)).toEqual(["dev"]);
    expect(mine?.runs[0]?.status).toBe("running");
    expect(mine?.runs[0]?.goal).toBe("ship");
    expect(mine?.runs[0]?.startedAt).toBeTypeOf("number");

    expect(snapshotFor(events, "session-b")?.runs).toEqual([]);
  });

  it("keeps a paused run reportable for the session that held it", async () => {
    const { events, tools } = await harness();
    const ctx = context(cwd, "session-a");
    await tools.get("multiloop_start")?.execute("call-1", { lane: "dev", mode: "dev", goal: "ship" }, undefined, undefined, ctx);
    await tools.get("multiloop_pause")?.execute("call-2", { target: "dev" }, undefined, undefined, ctx);

    const snapshot = snapshotFor(events, "session-a");
    expect(snapshot?.runs.map((run) => run.status)).toEqual(["paused"]);
    expect(snapshot?.runs[0]?.heldAt).toBeTypeOf("number");
    expect(snapshotFor(events, "session-b")?.runs).toEqual([]);
  });

  it("invalidates on attach and detach and ignores malformed requests", async () => {
    const { events, tools, changes } = await harness();
    const ctx = context(cwd, "session-a");
    expect(snapshotFor(events, "session-a")?.runs).toEqual([]);
    await tools.get("multiloop_start")?.execute("call-1", { lane: "dev", mode: "dev", goal: "ship" }, undefined, undefined, ctx);
    expect(changes.length).toBeGreaterThan(0);
    const afterStart = changes.length;
    await tools.get("multiloop_stop")?.execute("call-2", { target: "dev" }, undefined, undefined, ctx);
    expect(changes.length).toBeGreaterThan(afterStart);
    expect(snapshotFor(events, "session-a")?.runs.map((run) => run.status)).toEqual(["stopped"]);

    for (const value of [undefined, null, {}, { version: 2, sessionId: "s", respond() {} }, { version: 1 }]) {
      expect(() => events.emit(LOOP_ACTIVITY_REQUEST, value)).not.toThrow();
    }
  });
});
