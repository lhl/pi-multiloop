import { describe, expect, it } from "vitest";
import { assessAcceptance, ensureRequiredChecks, formatVerificationChecks, normalizeVerificationChecks } from "../extensions/pi-multiloop/verifiers.js";

describe("compound verifier acceptance", () => {
  it("keeps optimize iterations only when metric improves and all checks pass", () => {
    const result = assessAcceptance({ mode: "optimize" }, true, [
      { name: "correctness", kind: "mechanical", passed: true, command: "npm test" },
      { name: "output review", kind: "prompt", passed: true, evidence: "matches expected semantics" },
    ]);

    expect(result.acceptancePassed).toBe(true);
    expect(result.recommendedAction).toBe("keep");
    expect(result.acceptanceReason).toContain("metric improved");
    expect(result.acceptanceReason).toContain("all checks passed");
  });

  it("rejects optimize iterations when prompt correctness fails despite metric improvement", () => {
    const result = assessAcceptance({ mode: "optimize" }, true, [
      { name: "prompt correctness", kind: "prompt", passed: false, evidence: "output omitted required section" },
    ]);

    expect(result.acceptancePassed).toBe(false);
    expect(result.recommendedAction).toBe("revert");
    expect(result.acceptanceReason).toContain("metric improved");
    expect(result.acceptanceReason).toContain("failed checks: prompt correctness");
  });

  it("rejects optimize iterations when metric does not improve even if checks pass", () => {
    const result = assessAcceptance({ mode: "optimize" }, false, [
      { name: "correctness", passed: true },
    ]);

    expect(result.acceptancePassed).toBe(false);
    expect(result.recommendedAction).toBe("revert");
    expect(result.acceptanceReason).toContain("metric did not improve");
  });

  it("logs research/dev/punchlist iterations while preserving check pass status", () => {
    const result = assessAcceptance({ mode: "research" }, true, [
      { name: "candidate review", kind: "prompt", passed: false },
    ]);
    const punchlist = assessAcceptance({ mode: "punchlist", acceptanceMode: "log" }, false, [
      { name: "progress metric", kind: "mechanical", passed: true },
    ]);

    expect(result.recommendedAction).toBe("log");
    expect(result.acceptancePassed).toBe(false);
    expect(punchlist.recommendedAction).toBe("log");
    expect(punchlist.acceptancePassed).toBe(true);
  });

  it("allows explicit keep/revert acceptance for punchlist optimization loops", () => {
    const result = assessAcceptance({ mode: "punchlist", acceptanceMode: "keep-revert" }, true, [
      { name: "tests", passed: true },
    ]);

    expect(result.recommendedAction).toBe("keep");
    expect(result.acceptancePassed).toBe(true);
  });

  it("adds failing checks for configured guard/prompt verifiers that are not reported", () => {
    const checks = ensureRequiredChecks({
      guardCommand: "npm test",
      promptVerifier: "Review output semantics.",
    }, []);

    expect(checks).toHaveLength(2);
    expect(checks[0]).toMatchObject({ name: "guard", kind: "guard", command: "npm test", passed: false });
    expect(checks[1]).toMatchObject({ name: "prompt verifier", kind: "prompt", prompt: "Review output semantics.", passed: false });
  });

  it("does not add required checks when reported verdicts cover them", () => {
    const checks = ensureRequiredChecks({
      guardCommand: "npm test",
      promptVerifier: "Review output semantics.",
    }, [
      { name: "tests", kind: "mechanical", command: "npm test", passed: true },
      { name: "semantic review", kind: "prompt", prompt: "Review output semantics.", passed: true },
    ]);

    expect(checks).toHaveLength(2);
    expect(checks.every((check) => check.passed)).toBe(true);
  });

  it("does not treat unrelated mechanical checks as the configured guard", () => {
    const checks = ensureRequiredChecks({
      guardCommand: "npm test",
    }, [
      { name: "lint", kind: "mechanical", command: "npm run lint", passed: true },
    ]);

    expect(checks).toHaveLength(2);
    expect(checks[0]).toMatchObject({ name: "lint", passed: true });
    expect(checks[1]).toMatchObject({ name: "guard", command: "npm test", passed: false });
  });

  it("requires the configured prompt verifier to be reported explicitly", () => {
    const checks = ensureRequiredChecks({
      promptVerifier: "Review output semantics.",
    }, [
      { name: "generic prompt review", kind: "prompt", passed: true },
    ]);

    expect(checks).toHaveLength(2);
    expect(checks[0]).toMatchObject({ name: "generic prompt review", passed: true });
    expect(checks[1]).toMatchObject({ name: "prompt verifier", prompt: "Review output semantics.", passed: false });
  });

  it("normalizes missing names and formats evidence", () => {
    const checks = normalizeVerificationChecks([
      { name: " ", kind: " prompt ", passed: true, prompt: "  compare output  ", evidence: " ok " },
    ]);

    expect(checks[0]).toMatchObject({ name: "check-1", kind: "prompt", prompt: "compare output", evidence: "ok" });
    expect(formatVerificationChecks(checks)[0]).toContain("PASS check-1");
    expect(formatVerificationChecks(checks)[0]).toContain("prompt=`compare output`");
  });
});
