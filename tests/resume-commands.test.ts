import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureLaneDir, registerLoop } from "../extensions/pi-multiloop/lanes.js";
import { createInitialState, loadState, saveState } from "../extensions/pi-multiloop/state.js";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

type LoopStatus = "active" | "paused" | "completed";

interface CommandEntry {
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

interface ToolEntry {
  name: string;
  execute: (
    toolCallId: string,
    params: { target?: string },
    signal: unknown,
    onUpdate: unknown,
    ctx: ExtensionCommandContext
  ) => Promise<{ content: Array<{ type: string; text: string }> }>;
}

async function fixture() {
  vi.resetModules();
  const { default: register } = await import("../extensions/pi-multiloop/index.js");
  const cwd = mkdtempSync(join(tmpdir(), "multiloop-resume-"));
  roots.push(cwd);
  const notices: string[] = [];
  const sendUserMessage = vi.fn();
  const commands = new Map<string, CommandEntry>();
  const tools = new Map<string, ToolEntry>();
  const ctx = {
    cwd,
    hasUI: false,
    ui: { notify: (text: string) => notices.push(text), setStatus: vi.fn(), setWidget: vi.fn() },
    sessionManager: { getSessionId: () => "test", getSessionFile: () => undefined },
  } as unknown as ExtensionCommandContext;
  register({
    on: vi.fn(),
    registerCommand: (name: string, command: CommandEntry) => commands.set(name, command),
    registerTool: (tool: ToolEntry) => tools.set(tool.name, tool),
    registerMessageRenderer: vi.fn(),
    sendMessage: vi.fn(),
    sendUserMessage,
  } as unknown as Parameters<typeof register>[0]);

  function add(lane: string, status: LoopStatus) {
    const id = { lane, runTag: "run" };
    const stateDir = ensureLaneDir(cwd, id);
    const state = createInitialState(id, "optimize", "./bench.py", { goal: `${lane} objective` });
    state.status = status === "active" ? "running" : status;
    saveState(cwd, id, state);
    registerLoop(cwd, { ...id, mode: "optimize", status, startedAt: new Date().toISOString(), stateDir });
    return id;
  }

  return {
    cwd,
    notices,
    sendUserMessage,
    add,
    command: (args: string) => commands.get("multiloop")!.handler(args, ctx),
    resumeTool: (target?: string) =>
      tools.get("multiloop_resume")!.execute("call-1", target === undefined ? {} : { target }, undefined, undefined, ctx),
  };
}

describe("multiloop resume target selection", () => {
  it("resumes the only active loop when no target is given", async () => {
    const f = await fixture();
    const id = f.add("solo", "active");

    await f.command("resume");

    expect(loadState(f.cwd, id)?.status).toBe("running");
    expect(f.notices.at(-1)).toContain("Resumed loop solo/run");
    expect(f.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(f.sendUserMessage.mock.calls[0][0]).toContain("Resume active pi-multiloop work from persisted state.");
    expect(f.sendUserMessage.mock.calls[0][0]).not.toContain("Resolve a pi-multiloop resume request.");
  });

  it("ignores completed runs when only one loop is resumable", async () => {
    const f = await fixture();
    const id = f.add("active-lane", "active");
    f.add("old-lane", "completed");

    await f.command("resume");

    expect(loadState(f.cwd, id)?.status).toBe("running");
    expect(f.sendUserMessage.mock.calls[0][0]).toContain("Resume active pi-multiloop work from persisted state.");
  });

  it("hands an ambiguous resume to the agent", async () => {
    const f = await fixture();
    const one = f.add("one", "active");
    const two = f.add("two", "active");

    await f.command("resume");

    expect(f.notices.at(-1)).toContain("handing off to the agent");
    expect(loadState(f.cwd, one)?.status).toBe("running");
    expect(loadState(f.cwd, two)?.status).toBe("running");
    expect(f.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(f.sendUserMessage.mock.calls[0][0]).toContain("Resolve a pi-multiloop resume request.");
  });

  it("still resumes an explicitly targeted completed run", async () => {
    const f = await fixture();
    const id = f.add("done", "completed");

    await f.command("resume done/run");

    expect(loadState(f.cwd, id)?.status).toBe("running");
    expect(f.notices.at(-1)).toContain("Resumed loop done/run");
  });

  it("selects the same single loop for a bare tool call", async () => {
    const f = await fixture();
    const id = f.add("solo", "active");

    const result = await f.resumeTool();

    expect(loadState(f.cwd, id)?.status).toBe("running");
    expect(result.content[0].text).toContain("Resumed loop solo/run");
  });

  it("asks the agent for a target from the tool when several loops are eligible", async () => {
    const f = await fixture();
    f.add("one", "active");
    f.add("two", "active");

    const result = await f.resumeTool();

    expect(result.content[0].text).toContain("Resolve a pi-multiloop resume request.");
    expect(f.notices).toEqual([]);
  });
});
