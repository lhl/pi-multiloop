import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readRegistry,
  writeRegistry,
  registerLoop,
  getActiveLoops,
  getLoop,
  removeLoop,
  updateLoopStatus,
  laneDir,
  ensureLaneDir,
  generateRunTag,
  parseLaneId,
  formatLaneId,
  type LaneId,
  type RegistryEntry,
} from "../extensions/pi-multiloop/lanes.js";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "multiloop-test-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("registry", () => {
  it("returns empty registry when no file exists", () => {
    const reg = readRegistry(cwd);
    expect(reg.version).toBe(1);
    expect(reg.loops).toEqual([]);
  });

  it("round-trips registry through write/read", () => {
    const reg = { version: 1 as const, loops: [] };
    writeRegistry(cwd, reg);
    expect(readRegistry(cwd)).toEqual(reg);
  });

  it("registers a loop", () => {
    const entry: RegistryEntry = {
      lane: "perf",
      runTag: "run-001",
      mode: "optimize",
      status: "active",
      startedAt: new Date().toISOString(),
      stateDir: "state/autoloop/perf/run-001",
      verifyCommand: "echo 42",
    };
    registerLoop(cwd, entry);
    expect(getActiveLoops(cwd)).toHaveLength(1);
    expect(getLoop(cwd, { lane: "perf", runTag: "run-001" })).toEqual(entry);
  });

  it("updates existing loop on re-register", () => {
    const entry: RegistryEntry = {
      lane: "perf",
      runTag: "run-001",
      mode: "optimize",
      status: "active",
      startedAt: new Date().toISOString(),
      stateDir: "state/autoloop/perf/run-001",
      verifyCommand: "echo 42",
    };
    registerLoop(cwd, entry);
    registerLoop(cwd, { ...entry, status: "completed" });
    expect(readRegistry(cwd).loops).toHaveLength(1);
    expect(getLoop(cwd, { lane: "perf", runTag: "run-001" })?.status).toBe("completed");
  });

  it("removes a loop", () => {
    registerLoop(cwd, {
      lane: "perf",
      runTag: "run-001",
      mode: "optimize",
      status: "active",
      startedAt: new Date().toISOString(),
      stateDir: "state/autoloop/perf/run-001",
      verifyCommand: "echo 42",
    });
    removeLoop(cwd, { lane: "perf", runTag: "run-001" });
    expect(readRegistry(cwd).loops).toHaveLength(0);
  });

  it("updates loop status", () => {
    registerLoop(cwd, {
      lane: "perf",
      runTag: "run-001",
      mode: "optimize",
      status: "active",
      startedAt: new Date().toISOString(),
      stateDir: "state/autoloop/perf/run-001",
      verifyCommand: "echo 42",
    });
    updateLoopStatus(cwd, { lane: "perf", runTag: "run-001" }, "paused");
    expect(getLoop(cwd, { lane: "perf", runTag: "run-001" })?.status).toBe("paused");
  });

  it("filters active loops only", () => {
    registerLoop(cwd, {
      lane: "a",
      runTag: "r1",
      mode: "optimize",
      status: "active",
      startedAt: "",
      stateDir: "",
      verifyCommand: "",
    });
    registerLoop(cwd, {
      lane: "b",
      runTag: "r2",
      mode: "optimize",
      status: "completed",
      startedAt: "",
      stateDir: "",
      verifyCommand: "",
    });
    expect(getActiveLoops(cwd)).toHaveLength(1);
    expect(getActiveLoops(cwd)[0].lane).toBe("a");
  });
});

describe("lane paths", () => {
  it("constructs lane directory path", () => {
    const dir = laneDir(cwd, { lane: "perf", runTag: "run-001" });
    expect(dir).toContain("state/autoloop/perf/run-001");
  });

  it("creates lane directory", () => {
    const dir = ensureLaneDir(cwd, { lane: "perf", runTag: "run-001" });
    expect(dir).toContain("state/autoloop/perf/run-001");
  });
});

describe("identifiers", () => {
  it("generates run tags with date prefix", () => {
    const tag = generateRunTag();
    expect(tag).toMatch(/^run-\d{8}-\d{6}$/);
  });

  it("parses lane/run-tag strings", () => {
    expect(parseLaneId("perf/run-001")).toEqual({ lane: "perf", runTag: "run-001" });
    expect(parseLaneId("invalid")).toBeNull();
    expect(parseLaneId("a/b/c")).toBeNull();
  });

  it("formats lane IDs", () => {
    expect(formatLaneId({ lane: "perf", runTag: "run-001" })).toBe("perf/run-001");
  });
});
