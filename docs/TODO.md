# TODO

Future work tracked here. Current version: 0.3.0. Next publish target: TBD.

This file is the working cleanup plan distilled from `docs/FEEDBACK.md`.
Keep tasks bite-sized and commit each logical unit separately.

## Punchlist notation

- `[ ]` not started
- `[x]` done
- `[~]` partial, blocked, or intentionally deferred; include a short reason inline

## Before the next publish

### README and release surface

- [x] Soften the README claim from a full TUI dashboard to the Pi-native status surfaces that exist today.
- [x] Decide release target and close the changelog as `0.3.0` once this publish gate is complete.
- [x] Update `docs/PLAN.md` implementation checklist so completed scaffolding does not look undone.
- [x] Link `docs/STATE.md`, `docs/LOOP_GUIDE.md`, and this TODO from README.
- [x] Update README quick start to describe the final bare `/multiloop` default after command UX cleanup lands.

### Command and setup UX

- [x] Make bare `/multiloop` status-first: show attached running loops, detached resumable loops, and inactive/history buckets; launch the setup guide only when there is no useful existing loop state.
- [x] Rework `/multiloop ls` to sort reverse-chronologically, group by status, and collapse archived runs unless `--archived` is passed.
- [x] Route every freeform `/multiloop <text>` input through the setup guide with the text as the goal seed.
- [x] Delete the inline regex start parser after freeform-to-guide routing lands; do not spend effort polishing a parser we plan to remove.
- [x] Add a pure target resolver for command arguments and tests for it: exact `lane/run-tag`, lane-only, empty input, unknown input, and ambiguous lane matches.
- [x] Support lane-only `resume`, `pause`, `stop`, and `archive` when the target is unambiguous.
- [x] Keep `rm` strict and destructive-safe: require exact `lane/run-tag`; if exposed as a tool later, require confirmation or leave slash-only.
- [x] Add typed human-operation tools for safe ops: `multiloop_resume`, `multiloop_pause`, `multiloop_stop`, `multiloop_archive`.
- [x] Add LLM disambiguation handoff for parse failures after typed human-operation tools exist: provide registry snapshot and ask the model to call the right tool or ask the user to choose.
- [x] Add tests around guide seed prompt construction, target parsing, and list/status formatting helpers.

### Runtime hardening

- [x] Make `saveState` atomic: write temp file in the lane dir, fsync, then rename over `state.json`.
- [x] Define the expanded result-action vocabulary before adding counters: existing `keep`, `revert`, `log`, `skip`, plus new `crash` and `blocked` actions.
- [x] Add snapshot counters after action vocabulary is settled: `keeps`, `reverts`, `logs`, `crashes`, `blocked`, `lastAction`, `lastActionAt`.
- [x] Surface counters in `/multiloop status` and list/status helper tests.
- [x] Add a runtime-refusal reference section: measurement mismatch, missing configured guard/prompt verifier, no active loop, measured-but-not-decided iteration, stopped loop, and escalation exhaustion; include trigger, reason, and recovery for each.
- [x] Decide whether `multiloop_measure` should ever execute configured guard commands itself or keep requiring agent-supplied check verdicts; preserve the north star that pi-multiloop should not become the benchmark/test runner.
- [x] Align or prominently document status vocabulary (`state.status: running/stopped` vs `registry.status: active/completed`).
- [x] Add phase hints to tool descriptions so the tool list itself explains when to call iterate, measure, decide/log, and start.

### Publish gate

- [x] README matches actual command behavior.
- [x] CHANGELOG has a dated `0.3.0` section.
- [x] `package.json` version matches the changelog.
- [x] `npx tsc --noEmit` passes.
- [x] `npx vitest run` passes.
- [x] `pi install .` smoke test succeeds.

## After publish

### Punchlist semantics

- [x] Define punchlist states in code and docs:
  - `[ ]` open / not started
  - `[x]` done
  - `[~]` partial, blocked, or intentionally not completable; must include a reason when possible
- [x] Extend punchlist parsing to preserve state (`open`, `done`, `partial`) and line numbers.
- [x] Add an explicit loop acceptance mode to state, e.g. `acceptanceMode: "log" | "keep-revert"`, instead of inferring from `metricDirection` defaults.
- [x] Default punchlist loops to log/progress acceptance, not optimize-style keep/revert.
- [x] Allow explicit keep/revert punchlist loops only when the setup guide confirms a metric optimization goal in addition to checklist progress.
- [x] Add a standard punchlist verifier helper that counts open/done/partial items and emits a mechanical metric.
- [x] Define the default pattern for generated or helper verification code: place run-owned helpers under `.multiloop/active/<lane>/<runTag>/` while keeping user-provided verify commands first-class and optional.
- [x] Document how generated helpers compose with Pi/plugin built-ins and when the agent should prefer existing repo scripts instead.
- [x] Add tests for punchlist parsing, partial markers, progress metrics, and punchlist acceptance-mode behavior.

### Docs and guide unification

- [x] Make `docs/LOOP_GUIDE.md` the canonical setup contract.
- [x] Reduce duplication between `skills/multiloop/skill.md`, `docs/LOOP_GUIDE.md`, and `buildSetupGuidePrompt()`; the skill and runtime prompt should summarize and point at the canonical guide.
- [x] Name the two-phase boundary consistently: all clarification before launch; after explicit launch approval, continue autonomously until stopped, paused, completed, or blocked.
- [x] Prefer multiple-choice clarification prompts in the guide examples.
- [x] Add a short note that this is a dev-facing tool: the expected users are developers installing a loop helper, not a broad end-user audience.

### Optional follow-ons

- [ ] Wire a real Pi-native status widget only if the existing footer/status/list surfaces are insufficient.
- [ ] Composite modes, e.g. punchlist where each item can spawn an optimize sub-loop.
- [ ] Structured lessons schema for `lessons.md` entries.
- [ ] Typed resume-health decision for clean resume vs repaired resume vs fresh start.
- [ ] Web-search escalation rung after pivot exhaustion.
- [ ] CI / trusted npm publishing.
- [ ] Lane-level `.gitignore` hint for `.multiloop/`.
