# pi-multiloop

Multi-lane autonomous iteration loops for [pi](https://pi.dev). Run multiple independent experiment loops on the same worktree with isolated state, durable history, and flexible goal modes.

## Why

Existing loop extensions force one loop per session or one loop per worktree. When you're tuning a CUDA kernel and sweeping quantization parameters at the same time, those experiments touch different files but share the same build artifacts and environment. pi-multiloop gives each loop its own lane with independent state — no worktree sprawl, no merge pain.

## Features

- **Multi-loop isolation** — Run multiple loops on the same worktree with lane-based state isolation
- **Four modes** — Optimize (edit→measure→keep/revert), Punchlist (iterate until checklist complete), Research (ablation logging), Dev (implement→test→commit)
- **Use your own scripts** — The verify command is any bash command you already have
- **Statistical confidence** — MAD scoring for noisy benchmarks (GPU timing, training loss)
- **Durable history** — Append-only JSONL per lane survives context resets and session restarts
- **Escalation** — Automatic strategy refinement on consecutive failures (3→refine, 5→pivot, stop)
- **TUI dashboard** — Live status, metric history, and confidence levels per lane

## Install

```bash
pi install npm:pi-multiloop
```

## Quick Start

```bash
# Start an optimization loop
/multiloop
# Describe your goal: "improve inference latency"
# Specify verify command: "./bench.py --quick"
# Confirm and go

# Check status
/multiloop-status

# Start a second loop (different lane, same worktree)
/multiloop
# Describe: "reduce memory usage"
# Different lane name, same worktree

# Resume after restart
/multiloop resume perf/run-001

# Archive completed loop
/multiloop-archive perf/run-001
```

## Modes

### Optimize
Edit → measure → keep if improved, revert if not → repeat. For kernel tuning, performance work, training sweeps.

### Punchlist
Parse a markdown checklist, pick next unchecked item, implement, verify, check it off. Converge when all items are done.

### Research
Hypothesis → implement → measure → log results. No keep/revert — all results are preserved for comparison. For ablation studies and parameter sweeps.

### Dev
Pick task → implement → test → commit. General development with iteration tracking.

## How State Works

pi-multiloop keeps everything in a single `.multiloop/` directory at your repo root:

```
your-repo/
└── .multiloop/
    ├── registry.json                 # index of all loops
    ├── active/                       # running/paused/completed loops
    │   ├── perf/                     # one dir per lane
    │   │   └── run-20260503-053708/  # one dir per run
    │   │       ├── results.jsonl     # append-only iteration log
    │   │       ├── state.json        # resume snapshot
    │   │       └── lessons.md        # cross-run learning (optional)
    │   └── quant/                    # second lane, same worktree
    │       └── run-20260503-054200/
    │           ├── results.jsonl
    │           └── state.json
    └── archive/                      # moved here by /multiloop-archive
        └── 2026-05-03T05-39-...-perf-run-20260503-053708/
            ├── results.jsonl
            └── state.json
```

### File Reference

| File | Written when | Contents |
|---|---|---|
| `registry.json` | Loop start/stop/archive | Index of all loops (lane, run-tag, mode, status, verify command). One file per repo. |
| `state.json` | Every iteration + start/stop | Resume snapshot: iteration count, baseline, current/best metric, consecutive failures, pivot count, config. Overwritten each iteration. |
| `results.jsonl` | Every iteration | Append-only log — one JSON line per iteration with: action (keep/revert/log), metric, baseline, delta, confidence, hypothesis, changes, measurements array. Never overwritten. |
| `lessons.md` | On pivot escalation | Freeform notes appended when the loop pivots strategy. Carried forward to bias future hypotheses. |

### Lifecycle

1. **`/multiloop`** — Creates `.multiloop/` (if absent) with `registry.json` and `active/<lane>/<run-tag>/state.json`.
2. **Each iteration** — Appends to `results.jsonl`, overwrites `state.json`.
3. **`/multiloop stop`** — Updates status in both `state.json` and registry. Files stay on disk.
4. **`/multiloop resume`** — Reconstructs in-memory state from `results.jsonl` + `state.json`. No new files until next iteration.
5. **`/multiloop-archive`** — Moves the run directory from `active/` to `archive/` with a timestamp prefix.

### Gitignore

If you don't want loop state tracked in version control, one line does it:

```
.multiloop/
```

Some projects benefit from committing state (e.g., keeping a durable record of optimization runs alongside the code). The JSONL results are human-readable and diff-friendly — it's up to you.

### Path Conventions

Everything lives under `.multiloop/` relative to your repo root (pi's cwd). The base directory is not yet configurable — planned for v0.2.

## Composability

pi-multiloop focuses on iteration logic. It composes with:
- **pi-boomerang** — Context compression for long-running loops
- **pi-supervisor** — Goal enforcement and methodology steering
- **pi-review-loop** — Quality gate at the end of iterations

## Development

```bash
git clone https://github.com/lhl/pi-multiloop
cd pi-multiloop
npm install
npx vitest run
pi install file:.
```

## Related Projects

### Autoresearch / Autoloop

- [karpathy/autoresearch](https://github.com/karpathy/autoresearch) — The original: edit → benchmark → keep/revert → repeat. Established the pattern.
- [lhl/codex-autoresearch](https://github.com/lhl/codex-autoresearch) — Our fork of [leo-lilinxiao/codex-autoresearch](https://github.com/leo-lilinxiao/codex-autoresearch) adding multi-loop-per-worktree support via `LANE` + `RUN_TAG` isolation. Codex only — pi-multiloop is the pi equivalent.
- [uditgoenka/autoresearch](https://github.com/uditgoenka/autoresearch) — Claude Code / OpenCode / Codex autoresearch skill. Generalizes beyond ML to any domain with a measurable metric.
- [armgabrielyan/autoloop](https://github.com/armgabrielyan/autoloop) — Agent-agnostic autoloop with repo-aware setup inference, guardrails, and keep/discard verdicts. Works with Claude Code, Codex, Cursor, Gemini CLI.

### Awesome Lists

- [WecoAI/awesome-autoresearch](https://github.com/WecoAI/awesome-autoresearch) — Use cases with actual optimization traces (Vesuvius Challenge, Bitcoin prediction, agent improvement)
- [yibie/awesome-autoresearch](https://github.com/yibie/awesome-autoresearch) — Tools + real-world use cases (stock portfolios, cold email, fare search)
- [alvinreal/awesome-autoresearch](https://github.com/alvinreal/awesome-autoresearch) — Self-improving agents, end-to-end research automation, curated papers

### Pi Extensions

- [davebcn87/pi-autoresearch](https://github.com/davebcn87/pi-autoresearch) — Autonomous optimization loops for pi with TUI dashboard, MAD confidence scoring, and branch workflow
- [mikeyobrien/pi-autoloop](https://github.com/mikeyobrien/pi-autoloop) — Autonomous LLM loops for pi
- [nicobailon/pi-boomerang](https://github.com/nicobailon/pi-boomerang) — Token-efficient autonomous loops via execute → summarize → compact history
- [tintinweb/pi-supervisor](https://github.com/tintinweb/pi-supervisor) — Goal supervision with separate supervisor LLM steering the main agent
- [nicobailon/pi-review-loop](https://github.com/nicobailon/pi-review-loop) — Self-review until no issues remain, with smart exit detection
- [samfoy/pi-ralph](https://github.com/samfoy/pi-ralph) — Event-driven state machine with hat-based role transitions and workflow presets
- [nicobailon/pi-messenger](https://github.com/nicobailon/pi-messenger) — PRD → dependency DAG → wave execution for multi-agent coordination
- [burggraf/pi-teams](https://github.com/burggraf/pi-teams) — Persistent multi-agent teams with shared task board and terminal pane management
- [lsj5031/PiSwarm](https://github.com/lsj5031/PiSwarm) — Commander → Captain → wave workers with isolated git worktrees
- [ArtemisAI/pi-loop](https://github.com/ArtemisAI/pi-loop) — Cron/repeating prompts with dynamic pacing and dual-gate verify+guard
- [tintinweb/pi-schedule-prompt](https://github.com/tintinweb/pi-schedule-prompt) — Cron-like recurring prompt scheduling

## License

MIT
