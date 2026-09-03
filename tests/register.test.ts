import { describe, expect, it } from "vitest";
import register from "../extensions/pi-multiloop/index.js";

interface Recorded {
  handlers: Map<string, unknown>;
  commands: Map<string, { description: string; handler: unknown }>;
  tools: Map<string, { description: string; parameters: unknown }>;
  renderers: Map<string, unknown>;
}

function install(): Recorded {
  const recorded: Recorded = {
    handlers: new Map(),
    commands: new Map(),
    tools: new Map(),
    renderers: new Map(),
  };
  const pi = {
    on: (event: string, handler: unknown) => recorded.handlers.set(event, handler),
    registerCommand: (name: string, command: { description: string; handler: unknown }) =>
      recorded.commands.set(name, command),
    registerTool: (tool: { name: string; description: string; parameters: unknown }) =>
      recorded.tools.set(tool.name, tool),
    registerMessageRenderer: (type: string, renderer: unknown) => recorded.renderers.set(type, renderer),
    sendMessage: async () => {},
    sendUserMessage: async () => {},
  };
  // The extension API is wider than this stub; registration only touches these.
  register(pi as unknown as Parameters<typeof register>[0]);
  return recorded;
}

describe("extension registration", () => {
  it("registers both entry commands", () => {
    const { commands } = install();
    expect([...commands.keys()].sort()).toEqual(["goal", "multiloop"]);
  });

  it("registers the goal tools alongside the loop tools", () => {
    const { tools } = install();
    expect([...tools.keys()].sort()).toEqual([
      "get_goal",
      "multiloop_archive",
      "multiloop_decide",
      "multiloop_iterate",
      "multiloop_log",
      "multiloop_measure",
      "multiloop_pause",
      "multiloop_resume",
      "multiloop_start",
      "multiloop_stop",
      "update_goal",
    ]);
  });

  it("subscribes to the events the continuation arbiter needs", () => {
    const { handlers } = install();
    for (const event of [
      "session_start",
      "input",
      "agent_start",
      "agent_end",
      "tool_call",
      "session_before_compact",
      "session_compact",
    ]) {
      expect(handlers.has(event), `missing handler for ${event}`).toBe(true);
    }
  });

  it("no longer requires a verify command to start a run", () => {
    const { tools } = install();
    const start = tools.get("multiloop_start") as { parameters: { required?: string[] } };
    expect(start.parameters.required ?? []).not.toContain("verifyCommand");
    expect(start.parameters.required ?? []).toEqual(expect.arrayContaining(["lane", "mode", "goal"]));
  });

  it("describes the goal tools without usage or budget figures", () => {
    const { tools } = install();
    for (const name of ["get_goal", "update_goal"]) {
      const description = (tools.get(name) as { description: string }).description;
      expect(description).not.toMatch(/tokens?\s*(used|remaining|budget)/i);
      expect(description).not.toMatch(/budget/i);
      expect(description).not.toMatch(/elapsed|time used/i);
    }
  });

  it("tells the model that pause and resume are not its to make", () => {
    const { tools } = install();
    const description = (tools.get("update_goal") as { description: string }).description;
    expect(description).toContain("completion audit");
    expect(description).toContain("cannot pause, resume, or restart");
  });
});
