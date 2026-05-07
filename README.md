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
- **Compound verifiers** — combine a metric with mechanical guards and prompt-based correctness checks; keep is recommended only when the metric improves and all checks pass
- **Confidence scoring** — supports Median Absolute Deviation (MAD) to handle noisy benchmarks like GPU timing or training loss
- **Durable history** — append-only JSONL per lane, survives context resets and restarts
- **Mechanical continuation** — loop-owned turns automatically queue the next required action while the loop remains running, while still allowing brief answers to user status questions
- **Compaction-aware resume** — when pi auto-compacts during a loop explicitly started or resumed in the current session, pi-multiloop injects a loop-aware resume prompt after the interrupted turn ends
- **Escalation** — refines strategy automatically after consecutive failures
- **TUI dashboard** — live status and metric history per lane

## Install

```bash
pi install npm:pi-multiloop
```

## Quick Start

```bash
# Launch the setup guide (recommended for new loops)
/multiloop
# The guide scans the repo, proposes verify/guard/checks, asks for confirmation,
# then starts the loop after you reply "go".

# Or start directly with an inline config
/multiloop improve inference latency, verify: `./bench.py --quick`

# Start a compound verifier loop: metric + mechanical correctness + prompt review
/multiloop improve latency while completing docs/TODO.md, verify: `./bench.py --json`, guard: `npm test`, prompt verifier: `Review the generated output against fixtures; pass only if semantics are unchanged.`

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
Edit, measure, keep if improved or revert if not, repeat. Good for kernel tuning, performance work, training sweeps. If guard/prompt checks are configured or supplied to `multiloop_measure`, keep is recommended only when the metric improves **and** every check passes.

### Research
Hypothesis, implement, measure, log results. All results are preserved for comparison rather than kept/reverted. Good for ablation studies and parameter sweeps.

### Dev
Pick a task, implement, test, commit. General development with iteration tracking.

### Punchlist
Parse a markdown checklist, pick the next unchecked item, implement, verify, check it off. Done when all items pass.

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
| `state.json` | Every iteration + start/stop | Resume snapshot: iteration count, baseline, current/best metric, consecutive failures, pivot count, config, and any active measured-but-not-decided iteration. Overwritten each iteration. |
| `results.jsonl` | Every iteration | Append-only log — one JSON line per iteration with: action (keep/revert/log), metric, baseline, delta, confidence, hypothesis, changes, measurements array, verification checks, and acceptance verdict. Never overwritten. |
| `lessons.md` | On pivot escalation | Freeform notes appended when the loop pivots strategy. Carried forward to bias future hypotheses. |

For new loops, `/multiloop` (with no args) launches a setup guide. The guide scans the repo, asks at least one clarification round, proposes metric/verify/guard/checks, and starts via `multiloop_start` only after explicit approval.

### Lifecycle

1. **`/multiloop`** — Creates `.multiloop/` (if absent) with `registry.json` and `active/<lane>/<run-tag>/state.json`.
2. **Each iteration** — `multiloop_iterate` records an active iteration marker in `state.json`; `multiloop_measure` records pending measurements plus optional mechanical/prompt checks; `multiloop_decide`/`multiloop_log` appends to `results.jsonl`, clears the active marker, and overwrites `state.json`.
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
