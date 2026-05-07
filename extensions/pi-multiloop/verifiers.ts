import type { LoopState, VerificationCheck } from "./state.js";

export interface AcceptanceAssessment {
  checks: VerificationCheck[];
  checksPassed: boolean;
  acceptancePassed: boolean;
  acceptanceReason: string;
  recommendedAction: "keep" | "revert" | "log";
}

export function normalizeVerificationChecks(
  checks: VerificationCheck[] | undefined
): VerificationCheck[] {
  if (!Array.isArray(checks)) return [];
  return checks.map((check, index) => ({
    ...check,
    name: check.name?.trim() || `check-${index + 1}`,
    kind: check.kind?.trim() || undefined,
    command: check.command?.trim() || undefined,
    prompt: check.prompt?.trim() || undefined,
    evidence: check.evidence?.trim() || undefined,
    passed: Boolean(check.passed),
  }));
}

export function checksPassed(checks: VerificationCheck[]): boolean {
  return checks.every((check) => check.passed);
}

export function ensureRequiredChecks(
  state: Pick<LoopState, "guardCommand" | "promptVerifier">,
  checks: VerificationCheck[]
): VerificationCheck[] {
  const result = [...checks];
  if (state.guardCommand) {
    const hasGuard = result.some((check) =>
      check.command === state.guardCommand ||
      check.kind === "guard" ||
      (check.kind === "mechanical" && check.command !== undefined)
    );
    if (!hasGuard) {
      result.push({
        name: "guard",
        kind: "guard",
        command: state.guardCommand,
        passed: false,
        evidence: "Configured guard was not reported to multiloop_measure.checks.",
      });
    }
  }

  if (state.promptVerifier) {
    const hasPromptVerifier = result.some((check) =>
      check.prompt === state.promptVerifier || check.kind === "prompt"
    );
    if (!hasPromptVerifier) {
      result.push({
        name: "prompt verifier",
        kind: "prompt",
        prompt: state.promptVerifier,
        passed: false,
        evidence: "Configured prompt verifier was not reported to multiloop_measure.checks.",
      });
    }
  }

  return result;
}

export function assessAcceptance(
  state: Pick<LoopState, "mode">,
  metricImproved: boolean,
  checks: VerificationCheck[] | undefined
): AcceptanceAssessment {
  const normalized = normalizeVerificationChecks(checks);
  const allChecksPassed = checksPassed(normalized);
  const checksSummary = normalized.length === 0
    ? "no extra checks recorded"
    : allChecksPassed
      ? "all checks passed"
      : `failed checks: ${normalized.filter((check) => !check.passed).map((check) => check.name).join(", ")}`;

  if (state.mode === "research" || state.mode === "dev") {
    return {
      checks: normalized,
      checksPassed: allChecksPassed,
      acceptancePassed: allChecksPassed,
      acceptanceReason: checksSummary,
      recommendedAction: "log",
    };
  }

  const acceptancePassed = metricImproved && allChecksPassed;
  return {
    checks: normalized,
    checksPassed: allChecksPassed,
    acceptancePassed,
    acceptanceReason: `metric ${metricImproved ? "improved" : "did not improve"}; ${checksSummary}`,
    recommendedAction: acceptancePassed ? "keep" : "revert",
  };
}

export function formatVerificationChecks(checks: VerificationCheck[]): string[] {
  if (checks.length === 0) return [];
  return checks.map((check) => {
    const parts = [
      `${check.passed ? "PASS" : "FAIL"} ${check.name}`,
      check.kind ? `type=${check.kind}` : undefined,
      check.command ? `command=\`${check.command}\`` : undefined,
      check.prompt ? `prompt=\`${check.prompt}\`` : undefined,
      check.evidence,
    ].filter((part): part is string => Boolean(part));
    return `  - ${parts.join(" | ")}`;
  });
}
