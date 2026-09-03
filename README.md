# pi-multiloop

An autoloop/autoresearch/goal extension for [Pi](https://pi.dev) coding agent that lets you run multiple loops in the same worktree with isolated state per lane.

## Intro

Other loop extensions only support one loop per session or worktree. If you're tuning a CUDA kernel and sweeping quantization parameters at the same time, those experiments touch different files but share the same build artifacts. pi-multiloop lets each loop have its own lane with independent state, so you don't need extra worktrees or branches.

It also supports different loop types/styles. For more control, run `/multiloop` with a prompt to interactively create a run. This is best for optimization or auto-research loops where you want to create a verifier, etc. There is also a quick `/goal` mode that fires off a loop and let's the model fully decide what they want to do. (Both methods create ordinary runs under `.multiloop/`, so `ls`, `status`, `resume`, `pause`, `stop`, and `archive` work on either.)

## Features

- **Multi-loop isolation** — run multiple loops on the same worktree, each with its own lane and state
- **Five modes** — flexibly supports different types of loops:
  - **Optimize** — the classic edit, measure, keep/revert cycle
  - **Research** — log results from ablations or parameter sweeps without keep/revert
  - **Dev** — implement, test, commit with iteration tracking
  - **Punchlist** — iterate through a checklist until everything is done
  - **Quick goals** — use `/goal [task]` to get started working on a loop immediately (no setup, let the model decide)
- **Flexible goals** — verify with any script or command you want
- **Compound verifiers** — combine a metric with mechanical guards and prompt-based correctness checks; keep is recommended only when the metric improves and all checks pass
- **Confidence scoring** — supports Median Absolute Deviation (MAD) to handle noisy benchmarks like GPU timing or training loss
- **Durable history** — append-only JSONL per lane, survives context resets and restarts
- **Mechanical continuation** — loop-owned turns automatically queue the next required action while the loop remains running, while still allowing brief answers to user status questions
- **Compaction-aware resume** — when pi auto-compacts during a loop explicitly started or resumed in the current session, pi-multiloop injects a loop-aware resume prompt after the interrupted turn ends
- **Escalation** — refines strategy automatically after consecutive failures
- **Work accounting** — every run records elapsed time, turns, tool calls, and token totals, reported in status views and when a run ends
- **Pi-native status surfaces** — footer status, resumable-loop notices, and `/multiloop status` / `/multiloop ls` views

## Install

```bash
pi install npm:pi-multiloop
```

The package registers the `multiloop` skill. Pi loads its quick-goal, repository-scan, launch, measurement, and continuation rules on demand.

## Quick Start

```bash
# Set one objective and start working. No setup questions, no launch confirmation.
/goal fix the flaky Windows install

# Same, with a token cap that pauses the run when it is reached.
/goal --tokens 200k port the remaining tests to vitest

# Show the active goal and what it has cost so far.
/goal

# Hold it, pick it back up, or let it go (its history stays on disk).
/goal pause
/goal resume
/goal clear
```

```bash
# Show current loop state. If there is no existing loop state, this launches the setup guide.
/multiloop

# Explicitly launch the setup guide for a new loop.
/multiloop guide
# The guide scans the repo, proposes the whole configuration once,
# then starts the loop after you reply "go".

# Seed the guide with a natural-language goal. The agent still scans the repo and proposes before starting.
/multiloop improve inference latency, verify likely ./bench.py --quick

# Seed a compound verifier loop: metric + mechanical correctness + prompt review.
/multiloop improve latency while completing docs/TODO.md; use npm test as guard and review output semantics against fixtures

# Check detailed status and list runs.
/multiloop status
/multiloop ls
/multiloop ls --archived

# Resume, pause, stop, or archive. Lane-only works only when unambiguous; exact id is safest.
/multiloop resume perf/run-001
/multiloop pause perf
/multiloop stop perf/run-001
/multiloop archive perf/run-001
```

## More docs

- [Loop setup guide](skills/multiloop/references/LOOP_GUIDE.md) — setup contract and launch handoff (canonical version shipped with the multiloop skill).
- [State and lifecycle](docs/STATE.md) — registry/snapshot/runtime states, refusals, and compaction behavior.
- [Project plan](docs/PLAN.md) — north stars and scope.
- [Current TODO](docs/TODO.md) — publish gate and follow-on work.

## Modes

### Optimize
Edit, measure, keep if improved or revert if not, repeat. Good for kernel tuning, performance work, training sweeps. If guard/prompt checks are configured or supplied to `multiloop_measure`, keep is recommended only when the metric improves **and** every check passes.

### Research
Hypothesis, implement, measure, log results. All results are preserved for comparison rather than kept/reverted. Good for ablation studies and parameter sweeps.

### Dev
Pick a task, implement, test, commit. General development with iteration tracking.

### Punchlist
Parse a markdown checklist, pick the next open (`[ ]`) or partial (`[~]`) item, implement, verify, and check it off (`[x]`) or leave it partial with a reason. Punchlist loops default to log/progress acceptance using the `open_or_partial_items` metric; use keep/revert only for explicit metric optimization goals.

`/goal` picks one of these four from the objective's wording and defaults to `dev`. The mode only shapes how the agent approaches the work — a quick goal has no metric in any mode.

## Work accounting

Every run records elapsed active time, turns, tool calls, and cumulative input and output tokens. `/multiloop status` and `/goal` report them, and so does the notice printed when a run pauses or completes:

```
Goal ship-installer/run-001 — running
  fix the flaky Windows install
  mode dev, 4 recorded steps
  time 41m, 12 turns, 63 tool calls, 210K tokens
```

`/goal --tokens 200k <objective>` or `/goal tokens 200k` caps the total. When a run reaches its cap it pauses and tells you; raise or clear the cap with `/goal tokens <N|off>` and resume.

These counters never reach the agent. They measure cumulative work, not how full the context window is, and a running total delivered on every turn reads to a model like a context gauge — enough to make one wind down work that was not finished. Pi compacts context on its own; the counters have nothing to do with it.

## Compound Verifiers

`multiloop_measure` accepts optional verification checks alongside metric measurements:

```json
{
  "lane": "perf",
  "measurements": [356],
  "checks": [
    {"name": "unit tests", "kind": "mechanical", "passed": true, "command": "npm test"},
    {"name": "output correctness", "kind": "prompt", "passed": true, "evidence": "Output preserves required semantics"}
  ]
}
```

For keep/revert modes, the recorded acceptance passes only when the metric improves and every check passes. If a loop was started with `guard:` or `prompt verifier:` and the agent omits the corresponding check verdict, pi-multiloop records that missing verifier as a failed check. `multiloop_decide` rejects mismatched decisions, so a faster-but-incorrect output is mechanically forced to `revert` unless the agent reruns verification and records a passing result.

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
| `state.json` | Every iteration + start/stop | Atomic resume snapshot: iteration count, action counters, baseline, current/best metric, consecutive failures, pivot count, acceptance mode, config, and any active measured-but-not-decided iteration. |
| `results.jsonl` | Every iteration | Append-only log — one JSON line per iteration with: action (keep/revert/log/skip/crash/blocked), metric, baseline, delta, confidence, hypothesis, changes, measurements array, verification checks, and acceptance verdict. Never overwritten. |
| `lessons.md` | On pivot escalation | Freeform notes appended when the loop pivots strategy. Carried forward to bias future hypotheses. |

With existing loop state, bare `/multiloop` is status-first: it shows attached running loops, detached resumable loops, inactive/history buckets, and archived-run counts. If there is no useful existing state, bare `/multiloop` launches the setup guide. `/multiloop guide` always launches the guide explicitly. The guide scans the repo, proposes metric/verify/guard/checks in one message, and starts via `multiloop_start` on one approval. It asks a clarification round only when the scan found no command that produces a metric, when more than one plausible metric source exists, or when a proposed command is unsafe.

`/goal` skips all of that. It derives the lane from the objective, picks the mode from its wording, and starts a `.multiloop` run with no metric and no verify command. Such a run records progress with `multiloop_log` and finishes when the agent's completion audit passes, not when a number crosses a threshold.

### Lifecycle

1. **`/multiloop`** — Shows current loop state. If no useful state exists, launches the setup guide. A loop is created only after explicit approval and `multiloop_start`, which writes `.multiloop/registry.json` and `active/<lane>/<run-tag>/state.json`.
2. **Each iteration** — `multiloop_iterate` records an active iteration marker in `state.json`; `multiloop_measure` records pending measurements plus optional mechanical/prompt checks; `multiloop_decide`/`multiloop_log` appends to `results.jsonl`, updates action counters, clears the active marker, and atomically replaces `state.json`.
3. **`/multiloop stop`** — Updates status in both `state.json` and registry. Files stay on disk.
4. **`/multiloop resume`** — Explicitly reconstructs in-memory state from `results.jsonl` + `state.json` and sends a loop-aware resume prompt. No new files until next iteration.
5. **Auto-continuation during a current-session loop** — After a loop-owned turn ends, if the loop is still `running` and no user message is pending, pi-multiloop sends a follow-up prompt for the next required action. If a measurement is pending, the prompt forces decide/log before new work.
6. **Auto-compaction during a current-session loop** — Sends a resume prompt grounded in active `.multiloop/` state after compaction, including the common Pi threshold path where compaction happens immediately after `agent_end`. Manual idle `/compact` does not restart the agent.
7. **`/multiloop archive`** — Moves the run directory from `active/` to `archive/` with a timestamp prefix.

pi-multiloop does **not** auto-attach persisted active loops when a new Pi session starts. Registry entries remain available on disk, and startup prints a passive "available to resume" notice into the chat history when resumable loops exist, but a loop becomes active in memory only after `/multiloop` starts it or `/multiloop resume <lane/run-tag>` resumes it in the current session.

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
