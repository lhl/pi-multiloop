# Changelog

## Unreleased

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
