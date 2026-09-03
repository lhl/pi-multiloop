# pi-multiloop — Project Plan

## Why This Exists

The pi extension ecosystem has optimization loops (pi-autoresearch), goal supervision (pi-supervisor), context compression (pi-boomerang), and multi-agent orchestration (pi-teams). But none of them solve the fundamental problem: **running multiple independent experiment loops on the same worktree with isolated state**.

This matters because worktree-per-loop creates merge pain. When you're tuning a CUDA kernel and also sweeping quantization parameters, those experiments touch different files but share the same build artifacts, environment, and baseline. Separate worktrees mean maintaining parallel builds and reconciling divergent changes.

### North Stars

1. **Multi-loop isolation on the same worktree.** Each loop gets its own lane with independent state, results history, and convergence tracking — all sharing the same working directory.

2. **Use existing benchmark scripts.** Don't generate or own the measurement script. The verify command is whatever the user already has (`compose_*.py`, `bench_*.py`, `make test`, etc.). We wrap, we don't replace.

3. **Segmented durable history.** Every iteration is logged to append-only JSONL per lane+run-tag. Results survive context resets, session restarts, and can be queried across runs. The full history of what was tried, what worked, and what was reverted is always available.

4. **Flexible goal modes.** Not everything is metric optimization. Support punchlist-driven development (iterate until all checklist items are done), research ablations (log results without keep/revert), and general dev loops (implement→test→commit).

   Not everything has a metric at all, either. `/goal <objective>` derives its own lane, mode, and scope and starts with no setup, producing an ordinary run with no metric and no verify command that converges on a completion audit. Setup cost should match what the work actually needs.

5. **Steerability.** The agent should be steerable mid-loop — you can change the strategy, skip items, adjust thresholds, add constraints. Loops are a tool for the human, not an autonomous steamroller.

6. **Minimal state files.** Two files per loop (results.jsonl + state.json) plus one shared registry. Not five files with generated scripts, config JSONs, and hook directories.

7. **Work accounting belongs to the human.** Every run records elapsed time, turns, tool calls, and token totals, and reports them in status views and end-of-run notices. None of it is given to the agent: it measures cumulative work rather than context occupancy, and a running total delivered every turn reads to a model like a context gauge — enough to make one wind down work that is not finished.

### Gap Analysis

What exists vs. what we need:

| Capability | pi-autoresearch | codex-autoresearch (our fork) | pi-multiloop (this) |
|---|---|---|---|
| Edit→measure→keep/revert | Yes | Yes | Yes |
| Multi-loop per worktree | No | Yes (Codex only) | Yes |
| Use existing benchmark scripts | No (generates its own) | Yes | Yes |
| Statistical confidence (MAD) | Yes | No | Yes |
| Punchlist mode | No | Partial (plan mode) | Yes |
| Research/ablation mode | No | No | Yes |
| Dev mode (implement→test→commit) | No | No | Yes |
| Durable JSONL history | No (.jsonl but coupled) | Partial (TSV) | Yes |
| Lane isolation | No | Yes (path-based) | Yes |
| Metric-free quick goals | No | No | Yes |
| Work accounting per run | No | No | Yes |
| Shared results between loops | No | No | Planned (v0.2) |
| CI/exec non-interactive mode | No | Yes | Planned (v0.2) |
| TUI dashboard | Yes | No | Yes |
| Escalation on consecutive failures | No | Yes | Yes |
| Cross-run learning | No | Yes | Yes |
| Session-persistent state | Yes | Yes | Yes |
| Branch workflow | Yes | No | Optional |

### What We Explicitly Don't Do

- **Own the benchmark script.** pi-autoresearch wants to generate `autoresearch.sh` for you. We take any command.
- **Require separate worktrees.** PiSwarm uses worktree-per-agent. We use lane-per-loop on the same worktree.
- **Build in context compression.** pi-boomerang exists and composes with us. Install both if needed.
- **Build a second controller for goals.** `/goal` is a launch path into the same engine, not a parallel runtime with its own store. One set of state files, one continuation arbiter, one history.
- **Own broader goal supervision.** pi-supervisor exists and composes with us. Use it to enforce methodology over our iterations.
- **Report work counters to the agent.** They go to the user. See north star 7.
- **Spawn background processes.** v0.1 is in-process. Background mode (detached `pi --mode json`) is v0.2.

## Implementation Checklist

- [x] Scaffold repo (package.json, tsconfig, AGENTS.md, README.md)
- [x] lanes.ts — Lane/run-tag path resolution, registry management, target resolution
- [x] state.ts — JSONL append, atomic JSON snapshot, state reconstruction, action counters
- [x] metrics.ts — Metric parsing, MAD confidence scoring
- [x] loop.ts — Core iterate/keep/revert engine, escalation ladder
- [x] modes.ts — Mode definitions, punchlist parser, mode detection
- [x] index.ts — Extension entry point, pi events, tools, commands
- [x] goal.ts — Quick-goal parsing, lane/mode derivation, objective validation, goal prompts
- [x] tasks.ts — Read-only pi-tasks store discovery, snapshot, and prompt formatting
- [x] ui.ts — Pi-native status/list/resume surfaces plus dashboard formatting helpers
- [x] `SKILL.md` — Setup wizard skill prompt
- [x] Tests for lanes, state, metrics, loop engine, verifiers, prompts, list/status formatting
- [x] Tests for quick goals, work accounting, and extension registration
- [ ] Local install + integration test
- [ ] Add as devstack submodule
