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
  const guardCommand = state.guardCommand?.trim();
  if (guardCommand) {
    const hasGuard = result.some((check) =>
      check.command?.trim() === guardCommand
    );
    if (!hasGuard) {
      result.push({
        name: "guard",
        kind: "guard",
        command: guardCommand,
        passed: false,
        evidence: "Configured guard was not reported to multiloop_measure.checks.",
      });
    }
  }

  const promptVerifier = state.promptVerifier?.trim();
  if (promptVerifier) {
    const hasPromptVerifier = result.some((check) =>
      check.prompt?.trim() === promptVerifier
    );
    if (!hasPromptVerifier) {
      result.push({
        name: "prompt verifier",
        kind: "prompt",
        prompt: promptVerifier,
        passed: false,
        evidence: "Configured prompt verifier was not reported to multiloop_measure.checks.",
      });
    }
  }

  return result;
}

export function assessAcceptance(
  state: Pick<LoopState, "mode"> & Partial<Pick<LoopState, "acceptanceMode">>,
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

  const acceptanceMode = state.acceptanceMode ?? (state.mode === "optimize" ? "keep-revert" : "log");

  if (acceptanceMode === "log") {
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
