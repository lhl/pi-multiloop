import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  detectMode,
  parsePunchlist,
  nextUncheckedItem,
  checkOffItem,
  punchlistProgress,
  punchlistVerifierMetric,
} from "../extensions/pi-multiloop/modes.js";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "multiloop-modes-test-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("detectMode", () => {
  it("detects optimize from performance keywords", () => {
    expect(detectMode("improve latency")).toBe("optimize");
    expect(detectMode("reduce memory usage")).toBe("optimize");
    expect(detectMode("make it faster")).toBe("optimize");
    expect(detectMode("tune the kernel")).toBe("optimize");
    expect(detectMode("minimize throughput")).toBe("optimize");
  });

  it("detects optimize from metric keywords", () => {
    expect(detectMode("increase throughput")).toBe("optimize");
    expect(detectMode("maximize efficiency")).toBe("optimize");
  });

  it("detects punchlist from checklist keywords", () => {
    expect(detectMode("complete all items in punchlist")).toBe("punchlist");
    expect(detectMode("check off the todo list")).toBe("punchlist");
    expect(detectMode("finish all [ ] tasks")).toBe("punchlist");
  });

  it("detects research from experiment keywords", () => {
    expect(detectMode("ablation study on learning rate")).toBe("research");
    expect(detectMode("test different batch sizes")).toBe("research");
    expect(detectMode("parameter sweep for batch size")).toBe("research");
    expect(detectMode("grid search over hyperparams")).toBe("research");
  });

  it("detects dev from implementation keywords", () => {
    expect(detectMode("implement login page")).toBe("dev");
    expect(detectMode("build the API client")).toBe("dev");
    expect(detectMode("create a new component")).toBe("dev");
    expect(detectMode("refactor the state module")).toBe("dev");
  });

  it("defaults to optimize for unrecognized input", () => {
    expect(detectMode("do some random stuff")).toBe("optimize");
    expect(detectMode("")).toBe("optimize");
  });

  it("picks highest-scoring mode when keywords overlap", () => {
    // "improve" matches optimize, "speed" matches optimize, "implement" substring matches dev
    // optimize scores 2 (improve + speed), dev scores 1 (implement) → optimize wins
    expect(detectMode("improve the implementation speed")).toBe("optimize");
  });
});

describe("parsePunchlist", () => {
  it("parses unchecked checkboxes", () => {
    const content = "- [ ] do the thing\n- [ ] another task";
    const items = parsePunchlist(content);
    expect(items).toHaveLength(2);
    expect(items[0].text).toBe("do the thing");
    expect(items[0].checked).toBe(false);
    expect(items[0].state).toBe("open");
    expect(items[1].text).toBe("another task");
    expect(items[1].checked).toBe(false);
  });

  it("parses checked checkboxes", () => {
    const content = "- [x] done task\n- [X] also done";
    const items = parsePunchlist(content);
    expect(items).toHaveLength(2);
    expect(items[0].checked).toBe(true);
    expect(items[0].state).toBe("done");
    expect(items[1].checked).toBe(true);
    expect(items[1].state).toBe("done");
  });

  it("handles mixed checked/partial/unchecked", () => {
    const content = "- [x] done\n- [~] partial because blocked upstream\n- [ ] another";
    const items = parsePunchlist(content);
    expect(items[0].checked).toBe(true);
    expect(items[0].state).toBe("done");
    expect(items[1].checked).toBe(false);
    expect(items[1].state).toBe("partial");
    expect(items[1].text).toBe("partial because blocked upstream");
    expect(items[2].checked).toBe(false);
    expect(items[2].state).toBe("open");
  });

  it("preserves line numbers", () => {
    const content = "header\n\n- [ ] first\n- [ ] second";
    const items = parsePunchlist(content);
    expect(items[0].line).toBe(3);
    expect(items[1].line).toBe(4);
  });

  it("handles indented checkboxes", () => {
    const content = "  - [ ] indented item";
    const items = parsePunchlist(content);
    expect(items).toHaveLength(1);
    expect(items[0].text).toBe("indented item");
  });

  it("ignores non-checkbox list items", () => {
    const content = "- not a checkbox\n- [ ] real one\n- also not";
    const items = parsePunchlist(content);
    expect(items).toHaveLength(1);
    expect(items[0].text).toBe("real one");
  });

  it("returns empty for no checkboxes", () => {
    expect(parsePunchlist("just text")).toEqual([]);
    expect(parsePunchlist("")).toEqual([]);
  });
});

describe("nextUncheckedItem", () => {
  it("returns first unchecked item", () => {
    const items = parsePunchlist("- [x] a\n- [~] b\n- [ ] c");
    const next = nextUncheckedItem(items);
    expect(next).not.toBeNull();
    expect(next!.text).toBe("b");
  });

  it("returns null when all checked", () => {
    const items = parsePunchlist("- [x] a");
    expect(nextUncheckedItem(items)).toBeNull();
  });

  it("returns null for empty list", () => {
    expect(nextUncheckedItem([])).toBeNull();
  });
});

describe("checkOffItem", () => {
  it("checks off an unchecked item", () => {
    const filePath = join(cwd, "checklist.md");
    writeFileSync(filePath, "- [ ] task one\n- [ ] task two\n");
    checkOffItem(filePath, 1);
    const content = readFileSync(filePath, "utf-8");
    expect(content).toContain("- [x] task one");
    expect(content).toContain("- [ ] task two");
  });

  it("checks off a partial item", () => {
    const filePath = join(cwd, "checklist.md");
    writeFileSync(filePath, "- [~] partially done\n");
    checkOffItem(filePath, 1);
    const content = readFileSync(filePath, "utf-8");
    expect(content).toBe("- [x] partially done\n");
  });

  it("is idempotent (no double-check)", () => {
    const filePath = join(cwd, "checklist.md");
    writeFileSync(filePath, "- [x] already done\n");
    checkOffItem(filePath, 1);
    const content = readFileSync(filePath, "utf-8");
    expect(content).toBe("- [x] already done\n");
  });

  it("no-ops on non-existent file", () => {
    expect(() => checkOffItem(join(cwd, "nope.md"), 1)).not.toThrow();
  });

  it("no-ops on out-of-range line number", () => {
    const filePath = join(cwd, "checklist.md");
    writeFileSync(filePath, "one line\n");
    expect(() => checkOffItem(filePath, 99)).not.toThrow();
  });
});

describe("punchlistProgress", () => {
  it("calculates 0% for all unchecked", () => {
    const items = parsePunchlist("- [ ] a\n- [ ] b");
    const progress = punchlistProgress(items);
    expect(progress.total).toBe(2);
    expect(progress.done).toBe(0);
    expect(progress.open).toBe(2);
    expect(progress.partial).toBe(0);
    expect(progress.remaining).toBe(2);
    expect(progress.pct).toBe(0);
  });

  it("calculates 100% for all checked", () => {
    const items = parsePunchlist("- [x] a");
    const progress = punchlistProgress(items);
    expect(progress.pct).toBe(100);
    expect(progress.remaining).toBe(0);
  });

  it("calculates partial progress", () => {
    const items = parsePunchlist("- [x] a\n- [~] b\n- [ ] c");
    const progress = punchlistProgress(items);
    expect(progress.done).toBe(1);
    expect(progress.partial).toBe(1);
    expect(progress.open).toBe(1);
    expect(progress.remaining).toBe(2);
    expect(progress.pct).toBe(33);
  });

  it("emits a lower-is-better verifier metric for open or partial items", () => {
    const metric = punchlistVerifierMetric(parsePunchlist("- [x] a\n- [~] b\n- [ ] c"));

    expect(metric.metricName).toBe("open_or_partial_items");
    expect(metric.value).toBe(2);
    expect(metric.direction).toBe("lower");
    expect(metric.output).toContain("metric: 2");
    expect(metric.output).toContain("partial: 1");
  });

  it("returns 100% for empty list", () => {
    const progress = punchlistProgress([]);
    expect(progress.total).toBe(0);
    expect(progress.pct).toBe(100);
  });
});