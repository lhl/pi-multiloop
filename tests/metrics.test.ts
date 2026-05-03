import { describe, it, expect } from "vitest";
import {
  parseMetric,
  median,
  medianAbsoluteDeviation,
  assessConfidence,
  isImprovement,
  formatDelta,
  confidenceLabel,
} from "../extensions/pi-multiloop/metrics.js";

describe("parseMetric", () => {
  it("parses key=value format", () => {
    expect(parseMetric("latency: 42.5")).toEqual({ value: 42.5, raw: "latency: 42.5" });
    expect(parseMetric("score=99")).toEqual({ value: 99, raw: "score=99" });
    expect(parseMetric("time: 1.234")).toEqual({ value: 1.234, raw: "time: 1.234" });
  });

  it("parses bare number on last line", () => {
    expect(parseMetric("some output\n42")).toEqual({ value: 42, raw: "42" });
    expect(parseMetric("3.14")).toEqual({ value: 3.14, raw: "3.14" });
  });

  it("parses single number in output", () => {
    expect(parseMetric("The answer is 42 units")).toEqual({ value: 42, raw: "42" });
  });

  it("returns null for ambiguous output", () => {
    expect(parseMetric("values are 1, 2, 3")).toBeNull();
    expect(parseMetric("no numbers here")).toBeNull();
  });

  it("prefers key=value over bare numbers", () => {
    const result = parseMetric("iteration 5\nresult: 42.0\nother stuff");
    expect(result?.value).toBe(42.0);
  });
});

describe("median", () => {
  it("handles odd-length arrays", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([5])).toBe(5);
  });

  it("handles even-length arrays", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});

describe("medianAbsoluteDeviation", () => {
  it("computes MAD correctly", () => {
    expect(medianAbsoluteDeviation([1, 1, 2, 2, 4, 6, 9])).toBe(1);
  });

  it("returns 0 for identical values", () => {
    expect(medianAbsoluteDeviation([5, 5, 5])).toBe(0);
  });
});

describe("assessConfidence", () => {
  it("returns low confidence for single measurement", () => {
    const result = assessConfidence([42]);
    expect(result.confidence).toBe("low");
    expect(result.median).toBe(42);
  });

  it("returns medium confidence for 3 measurements", () => {
    const result = assessConfidence([10, 11, 12]);
    expect(result.confidence).toBe("medium");
  });

  it("returns high confidence for 5+ measurements", () => {
    const result = assessConfidence([10, 10, 11, 10, 10]);
    expect(result.confidence).toBe("high");
  });

  it("returns high confidence when MAD is 0", () => {
    const result = assessConfidence([42, 42]);
    expect(result.confidence).toBe("high");
    expect(result.mad).toBe(0);
  });
});

describe("isImprovement", () => {
  it("detects lower-is-better improvement", () => {
    expect(isImprovement(100, 80, 5, "lower")).toBe(true);
    expect(isImprovement(100, 99, 5, "lower")).toBe(false);
  });

  it("detects higher-is-better improvement", () => {
    expect(isImprovement(100, 120, 5, "higher")).toBe(true);
    expect(isImprovement(100, 101, 5, "higher")).toBe(false);
  });

  it("uses threshold multiplier", () => {
    expect(isImprovement(100, 90, 5, "lower", 2.0)).toBe(true);
    expect(isImprovement(100, 92, 5, "lower", 2.0)).toBe(false);
  });

  it("handles zero MAD (any improvement counts)", () => {
    expect(isImprovement(100, 99, 0, "lower")).toBe(true);
    expect(isImprovement(100, 100, 0, "lower")).toBe(false);
    expect(isImprovement(100, 101, 0, "lower")).toBe(false);
  });
});

describe("formatDelta", () => {
  it("formats lower-is-better improvement", () => {
    const result = formatDelta(100, 90, "lower");
    expect(result).toContain("-10");
    expect(result).toContain("improved");
  });

  it("formats lower-is-better regression", () => {
    const result = formatDelta(100, 110, "lower");
    expect(result).toContain("+10");
    expect(result).toContain("regressed");
  });
});

describe("confidenceLabel", () => {
  it("maps confidence levels", () => {
    expect(confidenceLabel("high")).toBe("HIGH");
    expect(confidenceLabel("medium")).toBe("MED");
    expect(confidenceLabel("low")).toBe("LOW");
  });
});
