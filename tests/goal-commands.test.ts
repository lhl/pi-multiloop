import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureLaneDir, registerLoop } from "../extensions/pi-multiloop/lanes.js";
import { createInitialState, loadState, saveState } from "../extensions/pi-multiloop/state.js";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function fixture() {
  vi.resetModules();
  const { default: register } = await import("../extensions/pi-multiloop/index.js");
  const cwd = mkdtempSync(join(tmpdir(), "multiloop-goal-"));
  roots.push(cwd);
  const notices: string[] = [];
  const sendUserMessage = vi.fn();
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
  const ctx = { cwd, hasUI: false, ui: { notify: (text: string) => notices.push(text), setStatus: vi.fn(), setWidget: vi.fn() }, sessionManager: { getSessionId: () => "test", getSessionFile: () => undefined } } as unknown as ExtensionCommandContext;
  register({ on: vi.fn(), registerCommand: (name: string, command: typeof commands extends Map<string, infer V> ? V : never) => commands.set(name, command), registerTool: vi.fn(), registerMessageRenderer: vi.fn(), sendMessage: vi.fn(), sendUserMessage } as unknown as Parameters<typeof register>[0]);
  function add(lane: string, kind: "goal" | "measured" = "goal") {
    const id = { lane, runTag: "run" };
    const stateDir = ensureLaneDir(cwd, id);
    const state = createInitialState(id, "dev", undefined, { kind, goal: `${lane} objective`, acceptanceMode: "log" });
    state.status = "paused";
    saveState(cwd, id, state);
    registerLoop(cwd, { ...id, mode: "dev", status: "paused", startedAt: new Date().toISOString(), stateDir });
    return id;
  }
  return { cwd, notices, sendUserMessage, add, command: (args: string) => commands.get("goal")!.handler(args, ctx) };
}

describe("goal commands", () => {
  it("lists goals with hints and controls a saved goal through its lifecycle", async () => {
    const f = await fixture();
    await f.command("");
    expect(f.notices.at(-1)).toContain("No running or paused goals");
    const id = f.add("first");
    for (const command of ["", "list", "ls", "status"]) {
      await f.command(command);
      expect(f.notices.at(-1)).toContain("first objective");
      expect(f.notices.at(-1)).toContain("/goal pause|stop|resume");
    }
    expect(f.sendUserMessage).not.toHaveBeenCalled();
    await f.command("resume");
    expect(loadState(f.cwd, id)?.status).toBe("running");
    expect(f.sendUserMessage).toHaveBeenCalledTimes(1);
    await f.command("pause");
    expect(loadState(f.cwd, id)?.status).toBe("paused");
    await f.command("stop first/run");
    expect(loadState(f.cwd, id)?.status).toBe("stopped");
    await f.command("resume first/run");
    expect(loadState(f.cwd, id)?.status).toBe("running");
  });

  it("rejects ambiguous and measured targets without asking the model", async () => {
    const f = await fixture();
    f.add("one"); f.add("two"); const measured = f.add("measured", "measured");
    await f.command("list");
    expect(f.notices.at(-1)).toContain("Other runs hidden: 1");
    expect(f.notices.at(-1)).not.toContain("measured objective");
    for (const command of ["resume", "resume measured/run", "stop measured/run", "pause measured/run", "stop missing/run"]) {
      await f.command(command);
      expect(f.notices.at(-1)).toContain("Could not select a goal");
    }
    expect(loadState(f.cwd, measured)?.status).toBe("paused");
    expect(f.sendUserMessage).not.toHaveBeenCalled();
  });
});
