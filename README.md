# pi-multiloop

An autoloop/autoresearch extension for [Pi](https://pi.dev) coding agent that lets you run multiple loops in the same worktree with isolated state per lane.

## Why

Other loop extensions only support one loop per session or worktree. If you're tuning a CUDA kernel and sweeping quantization parameters at the same time, those experiments touch different files but share the same build artifacts. pi-multiloop lets each loop have its own lane with independent state, so you don't need extra worktrees or branches.

## Features

- **Multi-loop isolation** — run multiple loops on the same worktree, each with its own lane and state
- **Four modes** — flexibly supports different types of loops:
  - **Optimize** — the classic edit, measure, keep/revert cycle
  - **Research** — log results from ablations or parameter sweeps without keep/revert
  - **Dev** — implement, test, commit with iteration tracking
  - **Punchlist** — iterate through a checklist until everything is done
- **Flexible goals** — verify with any script or command you want
- **Confidence scoring** — supports Median Absolute Deviation (MAD) to handle noisy benchmarks like GPU timing or training loss
- **Durable history** — append-only JSONL per lane, survives context resets and restarts
- **Compaction-aware resume** — when pi auto-compacts during an active loop, pi-multiloop injects a loop-aware resume prompt after the interrupted turn ends
- **Escalation** — refines strategy automatically after consecutive failures
- **TUI dashboard** — live status and metric history per lane

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
/multiloop status

# Start a second loop (different lane, same worktree)
/multiloop
# Describe: "reduce memory usage"
# Different lane name, same worktree

# Resume after restart
/multiloop resume perf/run-001

# Archive completed loop
/multiloop archive perf/run-001
```

## Modes

### Optimize
Edit, measure, keep if improved or revert if not, repeat. Good for kernel tuning, performance work, training sweeps.

### Research
Hypothesis, implement, measure, log results. All results are preserved for comparison rather than kept/reverted. Good for ablation studies and parameter sweeps.

### Dev
Pick a task, implement, test, commit. General development with iteration tracking.

### Punchlist
Parse a markdown checklist, pick the next unchecked item, implement, verify, check it off. Done when all items pass.

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
    └── archive/                      # moved here by /multiloop archive
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
5. **Auto-compaction during an active loop** — Sends a resume prompt grounded in active `.multiloop/` state after compaction, including the common Pi threshold path where compaction happens immediately after `agent_end`. Manual idle `/compact` does not restart the agent.
6. **`/multiloop archive`** — Moves the run directory from `active/` to `archive/` with a timestamp prefix.

### Gitignore

Add this to `.gitignore` if you don't want loop state in version control:

```
.multiloop/
```

You can also commit the state if you want a record of optimization runs alongside the code. The JSONL results are human-readable and diff-friendly.

### Path Conventions

Everything lives under `.multiloop/` relative to your repo root (pi's cwd).

## Composability

pi-multiloop handles iteration logic and composes with other Pi extensions:
- **pi-boomerang** — context compression for long-running loops
- **pi-supervisor** — goal enforcement and methodology steering
- **pi-review-loop** — quality gate at the end of iterations

## Development

```bash
git clone https://github.com/lhl/pi-multiloop
cd pi-multiloop
npm install
npx vitest run
pi install .
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
