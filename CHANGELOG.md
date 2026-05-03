# Changelog

## 0.1.1

- Rewrite README for clarity
- Add publish checklist (`docs/PUBLISH.md`)
- Add CHANGELOG

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
