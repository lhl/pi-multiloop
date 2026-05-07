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
  validateLaneId,
  resolveLoopTarget,
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
      stateDir: ".multiloop/active/perf/run-001",
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
      stateDir: ".multiloop/active/perf/run-001",
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
      stateDir: ".multiloop/active/perf/run-001",
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
      stateDir: ".multiloop/active/perf/run-001",
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
    expect(dir).toContain(".multiloop/active/perf/run-001");
  });

  it("creates lane directory", () => {
    const dir = ensureLaneDir(cwd, { lane: "perf", runTag: "run-001" });
    expect(dir).toContain(".multiloop/active/perf/run-001");
  });
});

describe("target resolver", () => {
  const loops: RegistryEntry[] = [
    {
      lane: "perf",
      runTag: "run-001",
      mode: "optimize",
      status: "active",
      startedAt: "2026-05-01T00:00:00.000Z",
      stateDir: ".multiloop/active/perf/run-001",
    },
    {
      lane: "docs",
      runTag: "run-002",
      mode: "punchlist",
      status: "paused",
      startedAt: "2026-05-02T00:00:00.000Z",
      stateDir: ".multiloop/active/docs/run-002",
    },
    {
      lane: "perf",
      runTag: "run-003",
      mode: "optimize",
      status: "completed",
      startedAt: "2026-05-03T00:00:00.000Z",
      stateDir: ".multiloop/active/perf/run-003",
    },
  ];

  it("returns empty for blank input", () => {
    expect(resolveLoopTarget(loops, " ")).toEqual({ status: "empty" });
  });

  it("resolves exact lane/run-tag input", () => {
    const result = resolveLoopTarget(loops, "perf/run-001");

    expect(result.status).toBe("resolved");
    if (result.status === "resolved") {
      expect(result.id).toEqual({ lane: "perf", runTag: "run-001" });
      expect(result.matchedBy).toBe("exact");
    }
  });

  it("resolves lane-only input when unambiguous", () => {
    const result = resolveLoopTarget(loops, "docs");

    expect(result.status).toBe("resolved");
    if (result.status === "resolved") {
      expect(result.id).toEqual({ lane: "docs", runTag: "run-002" });
      expect(result.matchedBy).toBe("lane");
    }
  });

  it("reports unknown input", () => {
    expect(resolveLoopTarget(loops, "missing").status).toBe("unknown");
    expect(resolveLoopTarget(loops, "missing/run-001").status).toBe("unknown");
  });

  it("reports invalid target syntax", () => {
    expect(resolveLoopTarget(loops, "perf/run 001").status).toBe("invalid");
    expect(resolveLoopTarget(loops, "../bad").status).toBe("invalid");
  });

  it("reports ambiguous lane-only input", () => {
    const result = resolveLoopTarget(loops, "perf");

    expect(result.status).toBe("ambiguous");
    if (result.status === "ambiguous") {
      expect(result.matches).toHaveLength(2);
    }
  });

  it("honors status filters", () => {
    const result = resolveLoopTarget(loops, "perf", { statuses: ["active"] });

    expect(result.status).toBe("resolved");
    if (result.status === "resolved") {
      expect(result.id).toEqual({ lane: "perf", runTag: "run-001" });
    }
    expect(resolveLoopTarget(loops, "docs/run-002", { statuses: ["active"] }).status).toBe("unknown");
  });
});

describe("identifiers", () => {
  it("generates run tags with date prefix", () => {
    const tag = generateRunTag();
    expect(tag).toMatch(/^run-\d{8}-\d{6}$/);
  });

  it("parses lane/run-tag strings", () => {
    expect(parseLaneId("perf/run-001")).toEqual({ lane: "perf", runTag: "run-001" });
    expect(parseLaneId(" perf/run-001 ")).toEqual({ lane: "perf", runTag: "run-001" });
    expect(parseLaneId("invalid")).toBeNull();
    expect(parseLaneId("a/b/c")).toBeNull();
  });

  it("rejects unsafe lane IDs", () => {
    expect(parseLaneId("../run-001")).toBeNull();
    expect(parseLaneId("perf/..")).toBeNull();
    expect(parseLaneId("perf/.hidden")).toBeNull();
    expect(parseLaneId("perf/run 001")).toBeNull();
    expect(parseLaneId("perf/run/../../oops")).toBeNull();
    expect(validateLaneId({ lane: "perf", runTag: "run_001.2" })).toBeNull();
    expect(validateLaneId({ lane: "..", runTag: "run-001" })).toContain("Invalid lane");
  });

  it("refuses to construct paths for unsafe IDs", () => {
    expect(() => laneDir(cwd, { lane: "..", runTag: "run-001" })).toThrow(/Invalid lane/);
    expect(() => ensureLaneDir(cwd, { lane: "perf", runTag: "../run-001" })).toThrow(/Invalid run tag/);
  });

  it("formats lane IDs", () => {
    expect(formatLaneId({ lane: "perf", runTag: "run-001" })).toBe("perf/run-001");
  });
});
