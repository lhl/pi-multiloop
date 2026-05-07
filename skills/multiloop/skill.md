---
name: multiloop
description: Start and manage autonomous iteration loops for optimization, punchlist completion, research, and development
triggers:
  - multiloop
  - start a loop
  - optimization loop
  - punchlist
  - iterate until
  - sweep
  - ablation
---

# Multiloop Setup Wizard

You are managing an autonomous iteration loop using pi-multiloop. When the user wants to start a new loop, guide them through setup.

## Mode Detection

Analyze the user's goal to detect the appropriate mode:

- **optimize**: Performance work, kernel tuning, latency reduction, throughput improvement. Uses edit→measure→keep/revert.
- **punchlist**: Completing a checklist from a file (e.g., `docs/PLAN.md`, `TODO.md`). Iterates until all `[ ]` items are `[x]`.
- **research**: Ablation studies, parameter sweeps, comparisons. Logs all results without keep/revert.
- **dev**: General development — implement features, fix bugs, iterate until tests pass.

## Setup Flow

1. **Ask for the goal** (if not already stated): "What are you trying to accomplish?"
2. **Detect mode** from the response and confirm: "This sounds like an [optimize/punchlist/research/dev] loop."
3. **Ask for the verify command**: "What command measures your metric?" For punchlist mode, ask for the checklist file path.
4. **Ask for the guard command** (optional): "Any command that must pass for changes to be valid? (e.g., `make test`)"
5. **Ask for prompt verifier / acceptance criteria** (optional): "Any prompt-based correctness check or human-readable acceptance rule?" Use this when output correctness cannot be fully captured by a command.
6. **Suggest a lane name** based on the goal (e.g., `perf`, `quant`, `plan`).
7. **Ask for scope** (optional): "Any specific files or directories to focus on?"
8. **Confirm and start**: Summarize the configuration, then use the `/multiloop` command with the parsed config.

## Runtime Hard Rules

When a loop is active, treat every resume/start/auto-continue prompt as an action contract, not as a request for a status report.

1. **Do not stop after one recorded decision.** If loop state remains `running`, continue into the next required action automatically unless the user pauses/stops it or a true blocker prevents safe work.
2. **A verification is not recorded just because a shell command printed a metric.** It counts only after `multiloop_measure` persists the measurement in `.multiloop/active/<lane>/<runTag>/state.json`.
3. **Compound verifiers require both metric and checks.** For goals like "improve performance while output remains correct", pass prompt/mechanical verdicts to `multiloop_measure.checks`; keep is valid only when the metric improves and all checks pass. If a configured guard or prompt verifier was run, include its verdict; omitted configured verifiers are recorded as failed checks.
4. **An iteration is not complete until `multiloop_decide` or `multiloop_log` appends `results.jsonl` and updates `state.json`.** Do not provide a final/status answer between measurement and decide/log.
5. **On resume, inspect active iteration state.** If `state.json` has `activeIteration.phase == "measured"`, call `multiloop_decide`/`multiloop_log` with the recorded measurements before starting a new iteration.
6. **Stop conditions:** user pause/stop, configured cap/goal reached if one exists, escalation exhaustion, or a true safety blocker. Do not ask "should I continue?" during an already-approved loop.

## During the Loop

When a loop is active:
1. **Each iteration**: Use `multiloop_iterate` before making changes, run verify/guard/prompt verifier, use `multiloop_measure` with `checks` when applicable, then `multiloop_decide` to keep/revert or `multiloop_log` for log-only modes.
2. **After decide/log**: If the tool reports the loop is still running, continue to the next iteration instead of summarizing.
3. **Monitor escalation**: If the agent gets 3 consecutive failures, it should refine. At 5, pivot. At 2 pivots exhausted, stop.
4. **Punchlist mode**: Read the checklist file, pick the next unchecked item, implement it, run guard, check it off.
5. **Research mode**: Use `multiloop_log` instead of decide — record all results for later comparison.

## Steerability

The user can intervene at any time:
- `/multiloop status` — detailed status of active loops
- `/multiloop ls` — list all registered loops
- `/multiloop stop [lane]` — stop a loop
- `/multiloop pause [lane]` — pause for manual intervention
- `/multiloop resume lane/run-tag` — resume a paused or stopped loop
- `/multiloop archive [lane/run-tag]` — archive completed loops
- `/multiloop rm lane/run-tag` — delete a loop and its state files
- `/multiloop help` — show available subcommands

## Context Management

pi-multiloop does not automatically inject active loop state into the system prompt and does not auto-resume persisted registry entries on session start. A loop becomes active in the current Pi session only after `/multiloop` starts it or `/multiloop resume lane/run-tag` resumes it.

Loop state is supplied through explicit start/resume prompts, tool results, `/multiloop status`, and compaction-aware resume prompts when Pi compacts during an active current-session loop. If running multiple loops, each has its own lane with independent state. Do not mix up which loop you're iterating on; always specify the lane name in tool calls.
