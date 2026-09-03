---
name: multiloop
description: Run and manage autonomous work — quick goals through /goal, and measured optimization, punchlist, research, and development loops through /multiloop. Use when the user sets a persistent objective, or requests repeated measured improvement, a bounded development loop, a research sweep, or punch-list completion.
license: MIT
compatibility: pi
triggers:
  - goal
  - multiloop
  - start a loop
  - optimization loop
  - punchlist
  - iterate until
  - sweep
  - ablation
---

# Multiloop

pi-multiloop runs autonomous work and keeps durable state for it. There are two ways in, and they have different launch costs.

## Two launch paths

| Path | User asks for | Setup | State |
| --- | --- | --- | --- |
| `/goal <objective>` | One objective, no metric | None. Lane, mode, and scope are derived and the run starts immediately. | `.multiloop/` |
| `/multiloop [seed]` | Repeated measured improvement | One repo scan, one proposal, one approval. | `.multiloop/` |

Both produce ordinary runs, so `/multiloop ls`, `status`, `resume`, `pause`, `stop`, and `archive` work on either.

**Choosing between them.** If the work has no metric and no command that verifies it, it is a quick goal — use `/goal` and do not run the setup proposal. If the user wants something measured and kept or reverted against a number, use `/multiloop`.

## Quick goals

A quick goal has no metric, no verify command, and no keep/revert. It converges on a completion audit instead of a threshold.

1. **Never run the setup proposal for a goal, and never ask for launch confirmation.** The user approved the run by typing `/goal`.
2. Do the next concrete action toward the objective. Record a finished step with `multiloop_log`.
3. Read the objective with `get_goal` when you need to confirm what you are working toward.
4. Before calling `update_goal`, run the completion audit in the continuation prompt: map every requirement in the objective to concrete evidence, inspect that evidence, and treat uncertainty as not achieved. Passing tests or substantial effort are not completion on their own.
5. Call `update_goal` with status `complete` only when the audit passes. It refuses while the task list has open tasks unless the user turned on `/goal allow-open-tasks`.
6. Pause, resume, budgets, and stopping are the user's to control. Do not pause or stop a goal yourself.

## Mode Detection

Analyze the user's goal to detect the appropriate mode:

- **optimize**: Performance work, kernel tuning, latency reduction, throughput improvement. Uses edit→measure→keep/revert.
- **punchlist**: Completing a checklist from a file (e.g., `docs/PLAN.md`, `TODO.md`). Tracks `[ ]` open, `[x]` done, and `[~]` partial/blocked items; defaults to log/progress acceptance until all open/partial items are resolved.
- **research**: Ablation studies, parameter sweeps, comparisons. Logs all results without keep/revert.
- **dev**: General development — implement features, fix bugs, iterate until tests pass.

## Measured Setup Flow

The canonical setup contract is [`references/LOOP_GUIDE.md`](references/LOOP_GUIDE.md) (resolved relative to this skill directory). Measured launches take one approval, not an interview:

1. **Scan**: read repo structure, manifests, scripts, tests, benches, and relevant checklists. Do not edit during setup.
2. **Propose once**: present goal, mode, lane, scope, metric and direction, acceptance mode, verify, guard, prompt verifier, stop condition, and rollback safety in one message. Mark every value you derived so the user can correct it in one reply. Do not make the user hand-write JSON or field names.
3. **Ask only when you must**: a clarification round is warranted when the scan found no command that produces a metric, when more than one plausible metric source exists and picking wrong would waste the run, or when a proposed command is destructive or unsafe. Otherwise propose defaults instead of asking.
4. **One approval**: any reply that accepts or corrects the proposal is the approval. Then call `multiloop_start` with the confirmed config and do not ask again unless a true safety blocker appears.

## Runtime Hard Rules

When a loop is active, status questions and side queries are allowed: answer them briefly, then continue the loop if state still says `running`.

1. **Do not stop after one recorded decision.** If loop state remains `running`, continue into the next required action automatically unless the user pauses/stops it or the loop state is no longer active.
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
4. **Punchlist mode**: Read the checklist file, pick the next `[ ]` open or `[~]` partial item, implement it, run guard, then mark `[x]` when done or `[~]` with a reason if intentionally partial/blocked.
5. **Research mode**: Use `multiloop_log` instead of decide — record all results for later comparison.

## Work accounting

Each run records elapsed time, turns, tool calls, and token totals. These are for the user: they appear in `/multiloop status`, `/goal`, the footer, and the end-of-run summary.

They are not a context-window measurement and they are never given to you. Compaction is automatic, and a long-running run is normal. Do not treat run length, or any counter you see in a status view the user pastes, as a reason to wrap up work that is not finished.

## Steerability

The user can intervene at any time:
- `/goal` — show the active goal and what it has cost
- `/goal pause` / `/goal resume` — hold a goal or pick it back up
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
