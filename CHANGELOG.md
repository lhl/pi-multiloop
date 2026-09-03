# Changelog

## Unreleased

### Added
- `/goal <objective>` starts an ordinary multiloop run with no setup interview and no launch confirmation. The lane comes from the objective, the mode from its wording, and the run carries no metric and no verify command; it records progress with `multiloop_log` and finishes on a completion audit. `/goal` also supports `pause`, `resume`, `clear`, `tokens <N|off>`, `allow-open-tasks <on|off>`, and `help`.
- `get_goal` and completion-only `update_goal` tools, with a completion gate that refuses while the pi-tasks list has open tasks unless the user turned on `/goal allow-open-tasks`.
- Work accounting per run: elapsed active time, turns, tool calls, and cumulative input and output tokens, reported in `/multiloop status`, `/goal`, and end-of-run notices. An optional token cap pauses the run when reached.
- pi-tasks integration: live task state is injected into quick-goal continuation prompts as untrusted data, and pi-multiloop stands down when pi-tasks has already queued the next turn.
- A run whose continuation makes no tool calls is paused instead of retried.

### Changed
- `multiloop_start` accepts a run with no `verifyCommand`. Such a run has no metric and uses log acceptance.
- The measured setup guide collapses to one repo scan, one proposal, and one approval. It asks a clarification round only when the scan found no command that produces a metric, when more than one plausible metric source exists, or when a proposed command is unsafe.
- Compaction resume reads Pi's `reason` and `willRetry` compaction event fields.

### Removed
- The five-second compaction timing window and the `isIdle`/`now`/`lastActiveAgentEndAt`/`lastInputAt`/`recentWindowMs` inputs to `decideCompactionResumeTiming`. It now takes `reason` and `willRetry`. This is a breaking change for anything importing that function directly.

## 0.3.3 - 2026-08-27

### Fixed
- Stop calling `fsyncSync()` on the lane directory in `saveState()`. Node cannot flush a directory handle on Windows, so every `multiloop_start` on Windows died with `EPERM: operation not permitted, fsync` before writing any loop state. The temporary-file write, file fsync, close, and atomic rename are unchanged; the directory flush now runs only where the platform supports it. Other filesystems that report `EPERM`, `ENOTSUP`, `EOPNOTSUPP`, or `EINVAL` from the directory flush skip the same optional step, while directory-open errors, other flush errors, and every file fsync error still fail the write.
- Rename the setup skill entrypoint to `SKILL.md` so Pi discovers and registers it from the declared package skill directory.

## 0.3.2 - 2026-05-15

### Fixed
- Move the canonical loop setup guide from `docs/LOOP_GUIDE.md` into the multiloop skill at `skills/multiloop/references/LOOP_GUIDE.md`. Previously the skill prompt and `buildSetupGuidePrompt()` cited `docs/LOOP_GUIDE.md` as a bare relative path; on npm or git installs the agent's cwd is the user's repo (not the package install dir), so the path missed the shipped file or picked up an unrelated doc. The guide now travels with the skill and resolves correctly under every install source.
- Drop the filesystem-path reference from `buildSetupGuidePrompt()`. The inlined summary is the runtime source of truth; the skill-side canonical file is mentioned as an informational pointer only, so launch behavior no longer depends on a successful `read` of an external doc.

### Changed
- README link to the loop setup guide now points at the skill-relative path.

## 0.3.1 - 2026-05-08

### Changed
- Update peerDependencies to `@earendil-works/*` scope (Pi 0.74.0+)
- Update imports to use `@earendil-works/pi-tui` and `@earendil-works/pi-coding-agent`

## 0.3.0 - 2026-05-08

### Added
- Add loop-owned auto-continuation: after start/resume/tool turns, running loops queue the next required action instead of relying on the model to keep going after one decide/log.
- Persist `activeIteration` markers in `state.json` so measured-but-not-decided iterations survive compaction/resume.
- Support compound verifiers by recording mechanical/prompt checks with `multiloop_measure`; keep/revert recommendations now combine metric improvement with all-checks-pass acceptance.
- Add a guided loop setup flow (`/multiloop` or `/multiloop guide`) plus `multiloop_start` so agents scan, clarify, confirm, and then start a well-formed loop.
- Add status-first bare `/multiloop`, grouped `/multiloop ls`, freeform goal seeding into the setup guide, lane-only target resolution, typed human-operation tools, and LLM disambiguation handoff.
- Add punchlist `[~]` partial state, log/progress acceptance mode, `open_or_partial_items` verifier metric helper, and action counters in loop snapshots.

### Changed
- Default punchlist, research, and dev loops to log/progress acceptance; optimize loops continue to use keep/revert acceptance by default.
- Make `state.json` writes atomic via temp-file write, fsync, and rename.
- Document runtime refusal/recovery behavior, status vocabulary, guard execution policy, and the canonical setup contract.
- Clarify README state/lifecycle docs for status-first bare `/multiloop` behavior and reconcile remaining feedback follow-ups in `docs/TODO.md`.

### Fixed
- Require `multiloop_decide` measurements to match the last recorded `multiloop_measure`, preventing unrecorded or stale verification decisions.
- Soften auto-continue prompts so status questions are answered first and then loop work resumes only if the loop is still running.
- Reconstruct state from accepted/logged results so reverted measurements do not become the current metric after resume.
- Persist escalation metadata so pivot failure-streak resets survive reconstruction.
- Validate lane and run-tag identifiers before using them in `.multiloop/active/...` paths.
- Reject empty measurement arrays and require configured guard/prompt verifier verdicts to match the configured command/prompt explicitly.

## 0.2.0 - 2026-05-07

### Added
- Add compaction-aware resume: if Pi compacts during or immediately after an active multiloop turn, pi-multiloop injects a loop-aware resume prompt grounded in active `.multiloop/` state instead of relying on a generic "continue".
- Show a passive startup notice in chat history listing active loops available to resume without attaching them to the new session.

### Changed
- Stop auto-attaching persisted active loops on Pi `session_start`; `/multiloop resume <lane/run-tag>` is now required to reactivate an existing loop in a new session.
- Stop injecting active loop context into every user prompt. Loop state is now supplied by explicit start/resume prompts and compaction resume prompts instead of global `before_agent_start` system-prompt mutation.

### Fixed
- Re-arm compaction-aware resume after every auto-compaction. Pi threshold compaction is emitted after the extension `agent_end` hook, so the resume logic now sends after `session_compact` when it follows a recent active agent turn instead of waiting for a second `agent_end`.
- Make the startup resumable-loops notice scroll with chat history instead of staying pinned as a persistent widget.
- Render the startup resumable-loops notice with Pi theme colors instead of the default custom-message box.

## 0.1.1

### Commands
- Consolidate all commands under `/multiloop` with subcommands: status, ls, stop, pause, resume, archive, rm, help
- Remove separate `/multiloop-status` and `/multiloop-archive` commands
- Add `rm` subcommand to delete loops and their state files
- Add `help` subcommand (also shown for bare `/multiloop`)

### Bug fixes
- Fix `formatDelta` division by zero when baseline is 0
- Fix `formatDelta` labeling unchanged metrics as "regressed"
- Fix null state crash in `loopSummary` on session reload
- Fix `stateDir` in registry not updating after archive
- Fix archived `state.json` retaining pre-archive status
- Fix archive catch block leaving stale registry entries
- Fix `multiloop_decide` silently using baseline=0 before any measurement
- Fix pause handler silently failing for registry-only loops
- Fix `reconstructState` not counting reverts through log/skip entries

### Type safety
- Add `"archived"` to `LoopState.status` union type

### Docs
- Rewrite README for clarity
- Add publish checklist (`docs/PUBLISH.md`)
- Add CHANGELOG
- Add TODO with v0.2 candidates (`docs/TODO.md`)
- Fix `pi install file:.` → `pi install .` across all docs

### Tests
- Add 57 tests for loop.ts and modes.ts (43 → 100 total)

## 0.1.0

Initial release.

- Multi-lane loop isolation on a single worktree
- Four modes: optimize, research, dev, punchlist
- MAD confidence scoring for noisy benchmarks
- Append-only JSONL history per lane with resume support
- Automatic escalation on consecutive failures (refine at 3, pivot at 5, stop)
- TUI dashboard with per-lane status and metric history
- `/multiloop`, `/multiloop-status`, `/multiloop-archive` commands
- Setup wizard skill
- Consolidated all state under `.multiloop/` directory
