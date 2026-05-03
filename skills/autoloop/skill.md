---
name: autoloop
description: Start and manage autonomous iteration loops for optimization, punchlist completion, research, and development
triggers:
  - autoloop
  - start a loop
  - optimization loop
  - punchlist
  - iterate until
  - sweep
  - ablation
---

# Autoloop Setup Wizard

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
7. **Confirm and start**: Summarize the configuration, then use the `/autoloop` command with the parsed config.

## During the Loop

When a loop is active:
1. **Each iteration**: Use `autoloop_iterate` before making changes, then `autoloop_measure` after running verify, then `autoloop_decide` to keep/revert.
2. **Monitor escalation**: If the agent gets 3 consecutive failures, it should refine. At 5, pivot. At 2 pivots exhausted, stop.
3. **Punchlist mode**: Read the checklist file, pick the next unchecked item, implement it, run guard, check it off.
4. **Research mode**: Use `autoloop_log` instead of decide — record all results for later comparison.

## Steerability

The user can intervene at any time:
- `/autoloop stop [lane]` — stop a loop
- `/autoloop pause [lane]` — pause for manual intervention
- `/autoloop resume lane/run-tag` — resume a paused or stopped loop
- `/autoloop list` — show all registered loops
- `/autoloop-status` — detailed status of active loops
- `/autoloop-archive lane/run-tag` — archive completed loop state

## Context Management

Active loops inject their state into the system prompt automatically. If running multiple loops, each has its own lane with independent state. Don't mix up which loop you're iterating on — always specify the lane name in tool calls.
