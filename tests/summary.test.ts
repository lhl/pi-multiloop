import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureLaneDir, registerLoop } from "../extensions/pi-multiloop/lanes.js";
import { createInitialState, saveState, type LoopState } from "../extensions/pi-multiloop/state.js";
import {
  RUN_SUMMARY_ENTRY,
  buildRunSummary,
  colorizeRunSummary,
  formatRunSummary,
  registerRunSummaryRenderer,
  runSummaryComponent,
  supportsRunSummaryCard,
  wallSeconds,
  type RunSummary,
} from "../extensions/pi-multiloop/summary.js";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const STARTED_AT = "2026-09-07T00:12:00.000Z";
const FINISHED_AT = "2026-09-07T02:40:00.000Z";

/** Fixed stamps keep locale and timezone out of the assertions. */
const formatStamp = (iso: string, includeDate: boolean) =>
  includeDate ? `<${iso}>` : `<time:${iso.slice(11, 16)}>`;

function goalState(overrides: Partial<LoopState> = {}): LoopState {
  const state = createInitialState({ lane: "flaky-tests", runTag: "run-001" }, "dev", undefined, {
    kind: "goal",
    goal: "make the auth tests deterministic",
    tokenBudget: 2_000_000,
  });
  state.startedAt = STARTED_AT;
  state.finishedAt = FINISHED_AT;
  state.iteration = 7;
  state.accounting = {
    activeSeconds: 6_660,
    turns: 34,
    toolCalls: 128,
    inputTokens: 1_300_000,
    outputTokens: 100_000,
  };
  return { ...state, ...overrides };
}

function measuredState(overrides: Partial<LoopState> = {}): LoopState {
  const state = createInitialState({ lane: "perf", runTag: "run-002" }, "optimize", "./bench.py", {
    goal: "reduce latency",
    metricName: "p50_ms",
  });
  state.startedAt = STARTED_AT;
  state.finishedAt = FINISHED_AT;
  state.iteration = 12;
  state.keeps = 8;
  state.reverts = 3;
  state.logs = 1;
  state.accounting = {
    activeSeconds: 6_660,
    turns: 34,
    toolCalls: 128,
    inputTokens: 1_300_000,
    outputTokens: 100_000,
  };
  return { ...state, ...overrides };
}

describe("run summary content", () => {
  it("marks a goal complete and names the run", () => {
    const summary = buildRunSummary(goalState(), "complete");
    expect(summary.kind).toBe("goal");
    expect(summary.steps).toBe(7);
    expect(formatRunSummary(summary, { formatStamp })).toBe(
      [
        "Goal complete · flaky-tests/run-001",
        "  make the auth tests deterministic",
        "  <time:00:12> → <time:02:40> · 2h 28m elapsed (1h 51m active)",
        "  7 steps · 34 turns · 128 tool calls · 1.4M of 2M tokens",
      ].join("\n")
    );
  });

  it("reports a measured run with its mode, iterations, and non-zero counters", () => {
    const summary = buildRunSummary(measuredState(), "stopped");
    const lines = formatRunSummary(summary, { formatStamp }).split("\n");
    expect(lines[0]).toBe("Run stopped · perf/run-002");
    expect(lines[3]).toBe("  mode optimize · 12 iterations · 8 kept, 3 reverted, 1 logged");
    expect(lines[4]).toBe("  34 turns · 128 tool calls · 1.4M tokens");
  });

  it("omits counters that are still zero", () => {
    const quiet = measuredState({ keeps: 0, reverts: 0, logs: 2 });
    expect(formatRunSummary(buildRunSummary(quiet, "stopped"), { formatStamp })).toContain(
      "mode optimize · 12 iterations · 2 logged"
    );
  });

  it("reports the metric the run reached and how the last iteration was accepted", () => {
    const state = measuredState({ baseline: 12, bestMetric: 0, lastAction: "keep" });
    const lines = formatRunSummary(buildRunSummary(state, "stopped"), { formatStamp }).split("\n");
    expect(lines[3]).toBe("  metric p50_ms: 0 best (baseline 12) · last iteration kept");
    expect(lines[4]).toBe("  mode optimize · 12 iterations · 8 kept, 3 reverted, 1 logged");
    expect(lines[5]).toBe("  34 turns · 128 tool calls · 1.4M tokens");
  });

  it("names the last action for every recorded outcome", () => {
    const labels = { revert: "reverted", log: "logged", skip: "skipped", crash: "crashed", blocked: "blocked" };
    for (const [action, label] of Object.entries(labels)) {
      const state = measuredState({ baseline: 12, bestMetric: 4, lastAction: action as LoopState["lastAction"] });
      expect(formatRunSummary(buildRunSummary(state, "paused"), { formatStamp })).toContain(
        `last iteration ${label}`
      );
    }
  });

  it("omits the baseline when the run never recorded one", () => {
    const state = measuredState({ baseline: null, bestMetric: 41, lastAction: "log" });
    expect(formatRunSummary(buildRunSummary(state, "stopped"), { formatStamp })).toContain(
      "  metric p50_ms: 41 best · last iteration logged"
    );
  });

  it("drops the metric name when the run never named one", () => {
    const state = measuredState({ metricName: undefined, baseline: 2, bestMetric: 1, lastAction: "keep" });
    expect(formatRunSummary(buildRunSummary(state, "stopped"), { formatStamp })).toContain(
      "  metric: 1 best (baseline 2) · last iteration kept"
    );
  });

  it("keeps the card unchanged when a measured run recorded no metric", () => {
    const text = formatRunSummary(buildRunSummary(measuredState(), "stopped"), { formatStamp });
    expect(text).not.toContain("metric");
  });

  it("leaves a goal without a metric line even when the state carries one", () => {
    const state = goalState({ baseline: 3, bestMetric: 1, lastAction: "keep" });
    expect(formatRunSummary(buildRunSummary(state, "complete"), { formatStamp })).not.toContain("metric");
  });

  it("dates both stamps only when the run crosses a calendar day", () => {
    const sameDay = buildRunSummary(goalState(), "complete");
    expect(formatRunSummary(sameDay, { formatStamp })).not.toContain("<2026");
    const overnight = goalState({ finishedAt: "2026-09-08T05:40:00.000Z" });
    expect(formatRunSummary(buildRunSummary(overnight, "complete"), { formatStamp })).toContain(
      "  <2026-09-07T00:12:00.000Z> → <2026-09-08T05:40:00.000Z>"
    );
  });

  it("states why a run paused and how to continue it", () => {
    const summary = buildRunSummary(goalState(), "paused", { reason: "token budget reached" });
    const text = formatRunSummary(summary, { formatStamp });
    expect(text).toContain("Goal paused (token budget reached) · flaky-tests/run-001");
    expect(text).toContain("Resume with /goal resume flaky-tests/run-001.");
  });

  it("points a measured run at the multiloop resume command", () => {
    const summary = buildRunSummary(measuredState(), "stopped");
    expect(formatRunSummary(summary, { formatStamp })).toContain(
      "Resume with /multiloop resume perf/run-002."
    );
  });

  it("leaves a completed goal with nothing left to resume", () => {
    const summary = buildRunSummary(goalState(), "complete");
    expect(summary.hint).toBeUndefined();
    expect(formatRunSummary(summary, { formatStamp })).not.toContain("Resume with");
  });

  it("drops elapsed time rather than inventing one from an unreadable stamp", () => {
    const summary = buildRunSummary(goalState({ finishedAt: "not-a-date" }), "stopped");
    const text = formatRunSummary(summary, { formatStamp });
    expect(text).toContain("<time:00:12> → <time:>");
    expect(text).not.toContain("elapsed");
    expect(wallSeconds(STARTED_AT, "not-a-date")).toBeUndefined();
  });

  it("survives a stamp that predates the start", () => {
    expect(wallSeconds(FINISHED_AT, STARTED_AT)).toBe(0);
  });

  it("carries the counters and accounting a caller can re-read later", () => {
    const summary: RunSummary = buildRunSummary(measuredState(), "stopped");
    expect(summary.counters).toEqual({ keeps: 8, reverts: 3, logs: 1, crashes: 0, blocked: 0 });
    expect(summary.accounting.toolCalls).toBe(128);
    expect(summary.startedAt).toBe(STARTED_AT);
    expect(summary.finishedAt).toBe(FINISHED_AT);
  });
});

describe("run summary styling", () => {
  it("colors the heading and mutes the stamp line without changing the text", () => {
    const text = formatRunSummary(buildRunSummary(goalState(), "complete"), { formatStamp });
    const styled = colorizeRunSummary(text, {
      fg: (name, value) => `[${name}]${value}[/${name}]`,
      bold: (value) => `*${value}*`,
    });
    expect(styled).toContain("[accent]*Goal complete");
    expect(styled).toContain("[muted]  <time:00:12>");
    expect(styled.replace(/\[[a-z]+\]|\[\/[a-z]+\]|\*/g, "")).toBe(text);
  });

  it("renders without a theme", () => {
    const text = formatRunSummary(buildRunSummary(goalState(), "complete"), { formatStamp });
    expect(colorizeRunSummary(text, {})).toBe(text);
  });

  it("renders through the real TUI component at a narrow width", () => {
    const component = runSummaryComponent(buildRunSummary(goalState(), "complete"), {
      fg: (_name, value) => value,
      bold: (value) => value,
    });
    const rendered = component.render(60).join("\n");
    expect(rendered).toContain("Goal complete · flaky-tests/run-001");
    expect(rendered).toContain("1.4M of 2M tokens");
  });
});

describe("run summary delivery", () => {
  async function fixture(options: { entryRenderers: boolean }) {
    vi.resetModules();
    const { default: register } = await import("../extensions/pi-multiloop/index.js");
    const cwd = mkdtempSync(join(tmpdir(), "multiloop-summary-"));
    roots.push(cwd);
    const notices: string[] = [];
    const entries: Array<{ customType: string; data: unknown }> = [];
    const messages: Array<{ content?: unknown }> = [];
    const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
    const renderers = new Map<string, unknown>();
    const tools = new Map<
      string,
      { execute: (...args: unknown[]) => Promise<{ content: Array<{ type: string; text: string }> }> }
    >();
    const pi = {
      on: vi.fn(),
      registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) =>
        commands.set(name, command),
      registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ type: string; text: string }> }> }) =>
        tools.set(tool.name, tool),
      registerMessageRenderer: vi.fn(),
      appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
      sendMessage: (message: { content?: unknown }) => messages.push(message),
      sendUserMessage: vi.fn(),
      ...(options.entryRenderers
        ? { registerEntryRenderer: (type: string, renderer: unknown) => renderers.set(type, renderer) }
        : {}),
    };
    const ctx = {
      cwd,
      hasUI: false,
      ui: { notify: (text: string) => notices.push(text), setStatus: vi.fn(), setWidget: vi.fn() },
      sessionManager: { getSessionId: () => "test", getSessionFile: () => undefined },
    } as unknown as ExtensionCommandContext;
    register(pi as unknown as Parameters<typeof register>[0]);

    const id = { lane: "perf", runTag: "run-002" };
    const stateDir = ensureLaneDir(cwd, id);
    const state = createInitialState(id, "optimize", "./bench.py", { goal: "reduce latency" });
    state.startedAt = STARTED_AT;
    state.accounting = { activeSeconds: 60, turns: 4, toolCalls: 9, inputTokens: 1_000, outputTokens: 500 };
    saveState(cwd, id, state);
    registerLoop(cwd, { ...id, mode: "optimize", status: "active", startedAt: STARTED_AT, stateDir });

    return {
      entries,
      messages,
      notices,
      renderers,
      stop: () => commands.get("multiloop")!.handler("stop perf/run-002", ctx),
      startGoal: (objective: string) => commands.get("goal")!.handler(objective, ctx),
      completeGoal: () =>
        tools.get("update_goal")!.execute("call-1", { status: "complete" }, undefined, undefined, ctx),
    };
  }

  it("writes the card as a session entry instead of a model message", async () => {
    const f = await fixture({ entryRenderers: true });
    await f.stop();
    const card = f.entries.find((entry) => entry.customType === RUN_SUMMARY_ENTRY);
    expect(card).toBeDefined();
    const summary = card!.data as RunSummary;
    expect(summary.outcome).toBe("stopped");
    expect(summary.finishedAt).toEqual(expect.any(String));
    expect(summary.accounting.toolCalls).toBe(9);
    expect(formatRunSummary(summary)).toContain("Run stopped · perf/run-002");
    // The card is display-only: no message carries the accounting text.
    expect(f.messages).toEqual([]);
    expect(f.notices).toEqual([]);
  });

  it("falls back to a notification when the host has no entry renderers", async () => {
    const f = await fixture({ entryRenderers: false });
    await f.stop();
    expect(f.entries).toEqual([]);
    expect(f.notices.join("\n")).toContain("Run stopped · perf/run-002");
  });

  it("cards a completed goal with its stamps, steps, and cost", async () => {
    const f = await fixture({ entryRenderers: true });
    await f.startGoal("make the auth tests deterministic");
    const result = await f.completeGoal();
    expect(result.content[0].text).toMatch(/^Goal .+ marked complete\.$/);

    const card = f.entries.find((entry) => entry.customType === RUN_SUMMARY_ENTRY);
    expect(card).toBeDefined();
    const summary = card!.data as RunSummary;
    expect(summary.outcome).toBe("complete");
    expect(summary.kind).toBe("goal");
    expect(summary.goal).toBe("make the auth tests deterministic");
    expect(Date.parse(summary.finishedAt)).toBeGreaterThanOrEqual(Date.parse(summary.startedAt));
    expect(summary.hint).toBeUndefined();
    const text = formatRunSummary(summary);
    expect(text).toContain("Goal complete ·");
    expect(text).toContain("make the auth tests deterministic");
    expect(text).toContain("elapsed");
    expect(text).toContain("0 steps · 0 turns · 0 tool calls · 0 tokens");
    expect(f.messages).toEqual([]);
  });

  it("registers a renderer only when the host supports one", async () => {
    const withRenderers = await fixture({ entryRenderers: true });
    await withRenderers.stop();
    expect(withRenderers.renderers.has(RUN_SUMMARY_ENTRY)).toBe(true);

    vi.resetModules();
    const { default: register } = await import("../extensions/pi-multiloop/index.js");
    expect(supportsRunSummaryCard({})).toBe(false);
    const bare = { on: vi.fn(), registerCommand: vi.fn(), registerTool: vi.fn(), registerMessageRenderer: vi.fn() };
    expect(() => register(bare as unknown as Parameters<typeof register>[0])).not.toThrow();
    expect(registerRunSummaryRenderer(bare)).toBe(false);
  });
});
