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
5. **Suggest a lane name** based on the goal (e.g., `perf`, `quant`, `plan`).
6. **Ask for scope** (optional): "Any specific files or directories to focus on?"
7. **Confirm and start**: Summarize the configuration, then use the `/multiloop` command with the parsed config.

## During the Loop

When a loop is active:
1. **Each iteration**: Use `multiloop_iterate` before making changes, then `multiloop_measure` after running verify, then `multiloop_decide` to keep/revert.
2. **Monitor escalation**: If the agent gets 3 consecutive failures, it should refine. At 5, pivot. At 2 pivots exhausted, stop.
3. **Punchlist mode**: Read the checklist file, pick the next unchecked item, implement it, run guard, check it off.
4. **Research mode**: Use `multiloop_log` instead of decide — record all results for later comparison.

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
