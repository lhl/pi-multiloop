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

## Lane State

Each loop stores state in `state/multiloop/<LANE>/<RUN_TAG>/`:
- `results.jsonl` — Append-only iteration log
- `state.json` — Resume snapshot
- `lessons.md` — Cross-run learning (optional)

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

## License

MIT
