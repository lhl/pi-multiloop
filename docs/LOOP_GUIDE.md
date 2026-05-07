# pi-multiloop Loop Setup Guide

Use this guide whenever a user wants to create a new autonomous loop but has not already provided a complete launch config.

## Goal

Help the user turn a natural-language goal into a safe, measurable, launch-ready pi-multiloop. The user should not need to know internal field names or write JSON by hand.

## Audience

pi-multiloop is a dev-facing tool for developers installing a loop helper into a repository. Optimize for clear repo-grounded defaults and safe operational handoff, not broad end-user onboarding.

## Hard Rules

1. **Clarify before launch.** Always scan the repo and ask at least one repo-grounded clarification round before starting a new loop.
2. **No edits during setup.** Reading files and running harmless discovery commands is allowed; code changes wait until the loop is launched.
3. **Propose defaults.** Ask concrete questions with suggested defaults rather than open-ended forms.
4. **Confirm before `multiloop_start`.** Present a short summary and wait for an explicit `go`, `start`, or `launch` before calling `multiloop_start`.
5. **Two-phase launch boundary.** All clarification happens before explicit launch approval. After approval, the loop continues autonomously until stopped, paused, completed, or blocked.

## Scan Checklist

Before asking the first question, inspect enough context to propose a good loop:

- repository structure and likely scope;
- manifest/build files (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, etc.);
- existing test/bench scripts and CI config;
- checklist/TODO/plan files for punchlist goals;
- prior `.multiloop/` state only when the user is resuming or comparing runs.

## What To Infer And Confirm

Use natural language with the user, but internally settle these fields:

| Field | What good looks like |
|---|---|
| Goal | Specific target outcome, not just “improve things”. |
| Mode | `optimize`, `punchlist`, `research`, or `dev`. |
| Lane | Short stable lane name, e.g. `perf`, `plan`, `correctness`. |
| Scope | Files/directories the loop may edit. |
| Metric | A number the verify command reports. |
| Direction | `lower` or `higher`. |
| Verify command | Existing command that emits the primary metric. |
| Guard command | Optional pass/fail command for regressions. |
| Prompt verifier | Optional LLM/human-readable criterion for correctness that commands cannot fully capture. |
| Acceptance policy | Usually “metric improves and all checks pass” for keep/revert loops. |
| Acceptance mode | `log` for punchlist/research/dev progress loops; `keep-revert` only for explicit metric optimization. |
| Stop condition | Target, iteration cap, or “until interrupted”. |
| Rollback safety | Whether normal revert is safe; never assume destructive reset is allowed. |

## Punchlist Semantics

Markdown punchlists use these states:

- `[ ]` — open / not started.
- `[x]` or `[X]` — done.
- `[~]` — partial, blocked, or intentionally not completable; include a short reason in the item text when possible.

Punchlist loops default to `acceptanceMode: "log"`: each iteration records progress and checks rather than optimize-style keep/revert. Use `acceptanceMode: "keep-revert"` for a punchlist only when the clarified goal includes a real metric optimization objective in addition to checklist progress, and the user confirms rollback safety.

The standard punchlist progress metric is `open_or_partial_items` (lower is better), computed as open `[ ]` plus partial `[~]` items. Prefer an existing repo verify command if one exists. If the agent needs a small generated helper, place run-owned helper code under `.multiloop/active/<lane>/<runTag>/` and call it from the verify command; do not overwrite repo scripts just to count checklist items.

Generated helpers compose with Pi/plugin built-ins as ordinary verify commands. Prefer existing repo scripts and tests first; generate a helper only when there is no first-class command for the metric.

## Compound Verifier Pattern

Use this when the goal has a metric and a correctness condition, for example: “complete the list, improve performance, and keep output correct.”

Recommended shape:

- **Verify:** measures progress/performance numerically.
- **Guard:** runs a mechanical correctness/smoke test when available.
- **Prompt verifier:** describes the semantic/output review criterion.
- **Acceptance:** metric improves **and** every mechanical/prompt check passes.

During runtime, the agent must pass check verdicts to `multiloop_measure.checks`. If a configured guard or prompt verifier is omitted, pi-multiloop treats it as failed, so an iteration cannot be kept by accident.

## Clarification Examples

Prefer one compact round with defaults and multiple-choice options:

- “I found `scripts/bench.py` and `npm test`. Metric choice: A) open/partial checklist items from `docs/TODO.md` (lower is better, recommended), B) benchmark latency from `scripts/bench.py`, or C) another metric?”
- “Guard choice: A) `npm test` (recommended), B) no guard, or C) a different command?”
- “Prompt verifier choice: A) ‘compare generated output with the baseline fixture and pass only if semantics are unchanged’, B) no prompt verifier, or C) a different criterion?”
- “Stop choice: A) until all TODO items are checked, B) cap at 10 iterations, or C) stop on a specific metric threshold?”

## Confirmation Summary

Before launch, show a concise summary:

```markdown
**Proposed loop**
- Target: ...
- Mode/lane: ...
- Scope: ...
- Metric: ... (direction: lower/higher)
- Verify: `...`
- Guard/checks: `...`; prompt verifier: ...
- Acceptance: metric improves and all checks pass
- Stop: ...

**Need to confirm**
- Only genuine blockers or choices.

**Next step**
Reply `go` to start, or tell me what to change.
```

## Launch Handoff

After explicit approval, call `multiloop_start` with the confirmed config. Do not ask the user to paste a generated command unless tool calling is unavailable.

Minimum `multiloop_start` config:

- `lane`
- `mode`
- `goal`
- `verifyCommand`
- `metricDirection`

Add `guardCommand`, `promptVerifier`, `acceptancePolicy`, `metricName`, and `scope` when known.
