# pi-multiloop State and Lifecycle

## What we are missing

pi-multiloop currently has enough state to know whether a loop is attached to this Pi runtime and marked `running`, but it does **not** have enough state to know whether the assistant is semantically still advancing that loop.

The important missing pieces are:

- **Loop-turn state is runtime-only.** We record in memory when a turn was caused by `/multiloop`, `/multiloop resume`, a compaction/auto-continue prompt, or loop tooling. This is sufficient for current-session continuation, but it is not durable across process restarts.
- **Persisted active-iteration markers now exist.** `multiloop_iterate` writes `activeIteration.phase = "started"`, `multiloop_measure` writes `activeIteration.phase = "measured"`, and `multiloop_decide`/`multiloop_log` clear it after appending `results.jsonl`.
- **No reliable manual-vs-auto compaction reason in extension events.** Pi's session stream has compaction reasons internally (`manual`, `threshold`, `overflow`), but current `session_before_compact` / `session_compact` extension events do not expose that reason.
- **No uniform record of built-in slash-command input.** Extension `input` events are emitted through `AgentSession.prompt()`. Built-in interactive commands such as `/compact` are handled before that path, so a last-user-submission heuristic cannot reliably see bare `/compact` unless Pi exposes it or changes command/input ordering.

The main remaining effect is around **manual compaction**. A manual idle `/compact` means the user is active and should usually not auto-restart a loop. However, from the extension event payload alone, a bare manual `/compact` can look like threshold auto-compaction. A custom manual `/compact <instructions>` is partly detectable because `customInstructions` is present in `session_before_compact`, but bare `/compact` is not.

This is otherwise a manageable corner case. The larger product behavior is now defined by clear attachment/running plus loop-turn ownership semantics: if a loop is attached, marked running, and the just-ended turn was loop-owned, pi-multiloop queues a follow-up for the next required action. Normal user input while idle clears loop-turn ownership, so unrelated prompts do not restart the loop.

## State layers

There are several independent state layers. Calling all of them "running" causes confusion.

### Durable registry state

Stored in `.multiloop/registry.json`.

| Registry status | Meaning |
| --- | --- |
| `active` | Loop exists on disk and is resumable. It may or may not be attached in the current Pi runtime. |
| `paused` | User paused the loop. It should not auto-resume. |
| `completed` | User stopped the loop or the loop exhausted escalation. Files remain under `.multiloop/active/...` until archived/deleted. |
| `archived` | Loop directory was moved under `.multiloop/archive/...`. |
| deleted | Registry entry and active lane directory were removed by `/multiloop rm`. |

Registry `active` means **available/resumable**, not necessarily live in the current session.

### Durable loop snapshot state

Stored in `.multiloop/active/<lane>/<runTag>/state.json`.

| Snapshot status | Meaning |
| --- | --- |
| `running` | The loop was started or resumed and is allowed to continue when attached. |
| `paused` | The loop is intentionally suspended. |
| `completed` | The loop completed normally. |
| `stopped` | The loop was stopped, usually by user command or escalation exhaustion. |
| `archived` | Archived copy of the state file. |

The snapshot also records iteration metrics:

- `iteration`: number of completed/logged iterations.
- `baseline`: first measured baseline, or `null` if not established.
- `currentMetric`: current kept/logged metric.
- `bestMetric`: best kept metric.
- `consecutiveFailures`: count used for escalation.
- `pivotCount`: number of pivots used.
- `verifyCommand` / `guardCommand`: commands the loop should run. `verifyCommand` is absent on a quick goal, which has no metric.
- `activeIteration`: optional marker for the next iteration when it has started or has measured-but-not-decided results, including recorded mechanical/prompt checks and the acceptance verdict.

It also records how the run was launched and what it has cost:

- `kind`: `"goal"` for a `/goal` run, `"measured"` otherwise. A snapshot written before this field existed is a measured run.
- `tokenBudget`: optional cumulative cap. Reaching it pauses the run.
- `allowOpenTasks`: when true, completion bypasses the open-task gate. User-owned.
- `accounting`: `activeSeconds`, `turns`, `toolCalls`, `inputTokens`, `outputTokens`.

`accounting` is reported to the user in `/multiloop status`, `/goal`, and end-of-run notices. It is never placed in a prompt, resume prompt, tool result, or tool description: it measures cumulative work rather than context occupancy, and a running total delivered every turn reads as a context-window gauge. `tests/accounting.test.ts` asserts this over every model-facing prompt builder.

### Append-only result state

Stored in `.multiloop/active/<lane>/<runTag>/results.jsonl`.

Each line records a completed iteration result:

- `keep`
- `revert`
- `log`
- `skip`

Rows also preserve metric measurements, optional verification checks, and the combined acceptance verdict. This is the authoritative history for reconstructing iteration count and failure streaks. It does not record started-but-unfinished work; that lives in the snapshot's optional `activeIteration` marker until a result is appended.

### Runtime attachment state

Stored in memory in `activeStates`.

| Runtime attachment | Meaning |
| --- | --- |
| detached | Loop may exist in the registry, but is not loaded into `activeStates`. Startup may show it as resumable. |
| attached/running | Loop is in `activeStates` and `state.status === "running"`. Tools can find it and compaction resume may consider it. |
| attached then removed | `/multiloop pause`, `/multiloop stop`, archive/delete, or escalation removed it from `activeStates`. |

Current `runningStates()` means:

```ts
activeStates.has(loop) && state.status === "running"
```

It does **not** mean the model is currently doing loop work.

### Pi agent/turn state

Pi exposes global session lifecycle events:

| Pi lifecycle state | Signal |
| --- | --- |
| idle | `ctx.isIdle()` is true / no active stream. |
| user input accepted | `input` event, but not for all built-in commands. |
| agent running | `agent_start` fired and `agent_end` has not fired. |
| agent ended | `agent_end` fired for the current prompt. |
| compacting | `session_before_compact` then `session_compact`. |
| pending queued messages | `ctx.hasPendingMessages()` reports steer/follow-up queue. |

This is global to the Pi session. pi-multiloop currently has no per-loop turn ownership.

## Command lifecycle

### Start: `/multiloop <goal>`

1. Scan the repo and propose the configuration once; start on one approval.
2. Detect mode and lane.
3. Generate run tag.
4. Create `.multiloop/active/<lane>/<runTag>/state.json` with status `running` and `kind: "measured"`.
5. Register loop in `.multiloop/registry.json` with status `active`.
6. Add state to `activeStates`.
7. Send a steer prompt telling the agent to establish a baseline and begin iterating.

Result:

- Registry: `active`
- Snapshot: `running`
- Runtime: attached/running

### Start: `/goal <objective>`

1. Derive the lane from the objective, suffixing on collision, and the mode from its wording (default `dev`).
2. Generate run tag.
3. Create the same state file with `kind: "goal"`, no `verifyCommand`, and `acceptanceMode: "log"`.
4. Register and attach exactly as above.
5. Send a start prompt carrying the objective as untrusted data, with no setup interview and no launch confirmation.

There is no separate goal store. A quick goal is a run, so `ls`, `status`, `resume`, `pause`, `stop`, `archive`, and `rm` all apply. `/goal clear` detaches the run and leaves its state and history on disk.

### Explicit resume: `/multiloop resume <lane/run-tag>`

1. Reconstruct state from `state.json` and `results.jsonl`.
2. Set snapshot status to `running`.
3. Add state to `activeStates`.
4. Set registry status to `active`.
5. Send a follow-up prompt with active loop context.

Result:

- Registry: `active`
- Snapshot: `running`
- Runtime: attached/running

### Pause: `/multiloop pause [lane]`

1. Set matching attached state(s) to `paused`.
2. Save `state.json`.
3. Set registry status to `paused`.
4. Remove from `activeStates`.
5. If no in-memory state matches, pause matching registry-only active loops.

Result:

- Registry: `paused`
- Snapshot: `paused`
- Runtime: detached

### Stop: `/multiloop stop [lane]`

1. Set matching attached state(s) to `stopped`.
2. Save `state.json`.
3. Set registry status to `completed`.
4. Remove from `activeStates`.
5. If no in-memory state matches, stop matching registry-only active loops.

Result:

- Registry: `completed`
- Snapshot: `stopped`
- Runtime: detached

### Archive: `/multiloop archive [lane/run-tag]`

1. Move the lane directory from `.multiloop/active/...` to `.multiloop/archive/...`.
2. Rewrite archived `state.json` status to `archived`.
3. Set registry status to `archived` and update `stateDir`.
4. Remove from `activeStates`.

Result:

- Registry: `archived`
- Snapshot: `archived`
- Runtime: detached

### Delete: `/multiloop rm <lane/run-tag>`

1. Remove the active lane directory if it exists.
2. Remove registry entry.
3. Remove from `activeStates`.

Result:

- Registry: deleted
- Snapshot: deleted
- Runtime: detached

## Tool lifecycle

### `multiloop_iterate`

Current behavior:

- Finds an attached loop by lane.
- Optionally reanchors state every 10 completed iterations.
- Writes `activeIteration.phase = "started"` to `state.json`.
- Returns context telling the assistant to run verify/guard.
- Does **not** append to `results.jsonl`.

Implication: if compaction or interruption happens after `multiloop_iterate` but before measurement/decision, resume prompts know which iteration is in progress.

### `multiloop_measure`

Current behavior:

- If no baseline exists, establishes baseline/current/best metric and saves `state.json`.
- Otherwise, reports whether the measurement improved relative to current baseline.
- Writes `activeIteration.phase = "measured"`, the measurements, metric, optional mechanical/prompt checks, acceptance verdict, and recommended keep/revert/log action to `state.json`.
- If `guardCommand` or `promptVerifier` is configured but the check verdict is omitted, records a failed synthetic check so missing correctness verification cannot accidentally produce `keep`.
- Does not append a result or increment iteration.

### `multiloop_decide`

Current behavior:

- Assesses confidence.
- Applies `keep`, `revert`, `log`, or `skip`.
- Requires the provided measurements and keep/revert action to match the recorded measured active iteration's combined acceptance result.
- Appends one result to `results.jsonl`.
- Increments `state.iteration`.
- Clears `activeIteration` and saves `state.json`.
- May trigger escalation, pivot, or stop.

### `multiloop_log`

Current behavior:

- Appends a `log`, `skip`, `crash`, or `blocked` result to `results.jsonl`.
- Increments `state.iteration`.
- Updates snapshot action counters (`logs`, `crashes`, `blocked`, `lastAction`, `lastActionAt`).
- Clears `activeIteration` and saves `state.json`.

## Runtime refusal and recovery reference

pi-multiloop intentionally refuses or redirects some actions rather than guessing. The recovery path should be explicit and state-grounded.

| Refusal | Trigger | Reason | Recovery |
| --- | --- | --- | --- |
| No active loop | A loop tool targets a lane that is not attached in `activeStates`. | Tools should not silently resurrect stale registry entries or operate on the wrong lane. | Run `/multiloop` to inspect status, then `/multiloop resume <lane/run-tag>` or call `multiloop_resume` with an exact target. |
| Missing baseline | `multiloop_decide` is called before any baseline/current metric exists. | Keep/revert decisions need a comparison point. | Run the configured verify command and call `multiloop_measure` to establish the baseline. |
| Empty measurements | `multiloop_measure` or `multiloop_decide` receives no numeric measurements. | Empty arrays used to become metric `0`, which could corrupt baselines. | Rerun the verify command and pass at least one numeric measurement. |
| Measurement mismatch | `multiloop_decide.measurements` differ from the last persisted `activeIteration.measurements`. | Prevents unrecorded, stale, or cherry-picked verification from deciding an iteration. | Call `multiloop_decide` with the recorded measurements, or rerun verify and `multiloop_measure` to replace them. |
| Missing configured guard/prompt verifier | A loop has `guardCommand` or `promptVerifier`, but `multiloop_measure.checks` omits the matching command/prompt verdict. | Faster-but-incorrect output must not be kept by omission. | Run the configured guard/prompt verifier and pass its verdict in `checks`; otherwise decide with the failed recommendation. |
| Measured-but-not-decided iteration | `multiloop_iterate` is called while `activeIteration.phase === "measured"`. | Starting new work would abandon a persisted measurement. | Finish the pending iteration with `multiloop_decide` or `multiloop_log` first. |
| Decision mismatch | `multiloop_decide.action` conflicts with the recorded acceptance recommendation. | Keep/revert must follow the measured metric plus required checks. | Use the recommended action, or rerun verify and `multiloop_measure` if the recorded result is stale. |
| Stopped/paused/detached loop | Commands/tools target a loop that is not eligible for the requested operation. | Avoid accidental operations on inactive or archived state. | Use `/multiloop` or `/multiloop ls --archived` to inspect, then resume/pause/stop/archive with an exact target if appropriate. |
| Ambiguous lane-only target | A command/tool receives a lane that matches multiple eligible runs. | Lane-only operations are safe only when unambiguous. | Provide exact `lane/run-tag`; slash commands hand off a registry snapshot so the model can call the typed tool or ask you to choose. |
| Escalation exhaustion | Consecutive failures exhaust the configured pivot budget. | The current autonomous search path is unlikely to recover without human review. | The loop stops; inspect `results.jsonl` and `lessons.md`, then start/resume a new strategy if desired. |

## Guard execution policy

`multiloop_measure` does **not** execute configured guard commands itself. The extension records metric/check verdicts supplied by the agent after the agent runs the repo's verify/guard commands. This preserves the north star that pi-multiloop wraps existing benchmark and test scripts; it does not become the benchmark runner, test runner, shell scheduler, or policy engine.

If a guard or prompt verifier is configured and the agent omits the matching check verdict, pi-multiloop records a synthetic failed check. That makes omission safe without giving the extension responsibility for command execution.

## Status vocabulary note

The registry and snapshot intentionally use different status vocabularies:

- Registry `active` means the loop is available/resumable on disk. It may be detached from the current Pi process.
- Snapshot `running` means the loop is allowed to continue automatically once attached to `activeStates`.
- Registry `completed` corresponds to snapshot `stopped` for user-stopped or escalation-stopped loops whose files remain under `.multiloop/active/...` until archived.
- Registry/snapshot `archived` means the run directory was moved under `.multiloop/archive/...` and is not resumable without manual restoration.

## Session startup lifecycle

On `session_start`, pi-multiloop currently prints a passive resumable-loops notice into chat history when detached active registry entries exist.

It does **not**:

- load active registry entries into `activeStates`;
- inject loop context into the system prompt;
- auto-resume loops from disk.

A registry `active` loop on startup is therefore **detached but resumable** until the user explicitly runs `/multiloop resume <lane/run-tag>`.

## Compaction lifecycle

### What Pi does

Pi may compact because:

- user invoked `/compact`;
- context crossed the threshold;
- provider returned context overflow and Pi is trying to recover.

Pi extension events currently visible to pi-multiloop are:

1. `session_before_compact`
2. `session_compact`

The extension event does not expose the compaction reason. `session_before_compact` does expose `customInstructions`, which only helps identify manual compaction when the user supplied instructions.

### Current pi-multiloop behavior

`decideCompactionResumeTiming` reads Pi's reported compaction cause. It uses:

- `agentRunning`
- `loopTurnActive` / `loopTurnReason`
- `reason` (`manual`, `threshold`, or `overflow`) from the compaction event
- `willRetry` from the compaction event
- `resumeAfterCompact` / `lastCompactionEntryId` to defer a resume past the current turn

The policy is:

- no attached running loop: skip;
- `willRetry`: skip, because overflow recovery re-runs the aborted turn itself;
- `manual` while the agent is idle: skip, because the user asked to compact, not to restart the loop;
- agent still running: resume after `agent_end`;
- otherwise: resume after `session_compact`.

Through 0.3.3 this was inferred from timing — a five-second window over `lastActiveAgentEndAt` and `lastInputAt` — which could not distinguish a bare manual `/compact` shortly after a loop turn from automatic threshold compaction. Pi now reports the cause directly, so the window is gone.

## Is a user typing into a non-moving loop inactive?

Mechanically, no.

If a loop is attached in `activeStates` and `state.status === "running"`, current code treats it as resumable/eligible. Automatic continuation additionally requires a loop-owned turn; normal user input while idle clears loop-turn ownership.

Semantically, unknown.

The user input might be:

- steering the active loop;
- asking a side question;
- manually recovering after compaction;
- interrupting the loop;
- planning to pause/stop but not yet issuing the command;
- unrelated to the loop.

pi-multiloop cannot infer intent reliably without either model classification or explicit user commands. The safer default is to treat normal user input as user control and avoid extra auto-resume unless the loop turn was clearly interrupted by compaction.

## Better state model

A clearer internal model would distinguish:

| Concept | Meaning |
| --- | --- |
| attached | Loop is loaded into `activeStates`. |
| running | Loop is allowed to continue automatically when a loop-owned turn needs recovery. |
| loop-turn-active | Current agent turn is known to be loop-owned. |
| idle-running | Loop is attached/running but no agent turn is active. |
| user-controlled | User submitted ordinary input while no loop-owned turn was active. |
| compacting-loop-turn | Compaction interrupted or followed a loop-owned turn. |

The implemented ownership flag is `loopTurnActive`.

Ways to set it:

- when `/multiloop <goal>` sends the initial steer prompt;
- when `/multiloop resume` sends its explicit resume prompt;
- when pi-multiloop sends a compaction resume prompt;
- when a loop tool is called during a turn;
- optionally when a normal user prompt explicitly names an attached loop, if we add classification later.

Ways to clear it:

- after `agent_end` after optionally queueing auto-continuation;
- when a normal user input arrives while idle;
- when the loop is paused/stopped/archived/deleted;
- after a compaction resume prompt is sent or intentionally skipped.

## Compaction reason, as shipped

Pi exposes the compaction cause on both `session_before_compact` and `session_compact`:

```ts
type CompactionReason = "manual" | "threshold" | "overflow";

session_before_compact.reason: CompactionReason
session_before_compact.willRetry: boolean
session_compact.reason: CompactionReason
session_compact.willRetry: boolean
```

- `manual`: the user invoked `/compact` or an extension requested compaction.
- `threshold`: automatic compaction because context crossed the configured threshold.
- `overflow`: automatic recovery after a provider context-overflow error. `willRetry` is set when the aborted turn will be re-run.

pi-multiloop reads both fields through `compactionReason()` and `compactionWillRetry()`, which fall back to `undefined`/`false` on a harness that does not supply them. With no reason available and the agent between turns, the policy resumes; that matches the old heuristic's most common case without the timing guess.

Requesting compaction is a separate concern. pi-multiloop does not request it, and Pi's `AgentSession.compact()` aborts the running turn before compacting, so an extension that wants to request one must defer the call until the turn has settled.
