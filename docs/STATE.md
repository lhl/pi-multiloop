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
- `verifyCommand` / `guardCommand`: commands the loop should run.
- `activeIteration`: optional marker for the next iteration when it has started or has measured-but-not-decided results, including recorded mechanical/prompt checks and the acceptance verdict.

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

1. Detect mode and lane.
2. Generate run tag.
3. Create `.multiloop/active/<lane>/<runTag>/state.json` with status `running`.
4. Register loop in `.multiloop/registry.json` with status `active`.
5. Add state to `activeStates`.
6. Send a steer prompt telling the agent to establish a baseline and begin iterating.

Result:

- Registry: `active`
- Snapshot: `running`
- Runtime: attached/running

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

- Appends a `log` result to `results.jsonl`.
- Increments `state.iteration`.
- Clears `activeIteration` and saves `state.json`.

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

Current code uses these pieces of state:

- `agentRunning`
- `resumeAfterCompact`
- `lastCompactionEntryId`
- `pendingCompactionResumeTiming`
- `lastActiveAgentEndAt`
- `lastInputAt`
- `loopTurnActive` / `loopTurnReason`
- a 5 second recent window

The intent is:

- if compaction happens during a loop-owned active agent turn, resume after `agent_end`;
- if Pi threshold-compacts immediately after a loop-owned turn, resume after `session_compact`;
- if compaction is pre-prompt, skip because the submitted prompt will continue normally;
- if manual idle `/compact`, skip.

The weak part is the time-based classification. A bare manual `/compact` soon after an active loop turn can look like auto threshold compaction.

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

## Best compaction fix: expose reason upstream

The best solution is an upstream Pi extension API change: expose compaction `reason` on `session_before_compact` and `session_compact`.

Pi core already knows this reason internally:

- `manual`: user invoked `/compact`.
- `threshold`: automatic compaction because context crossed the configured threshold.
- `overflow`: automatic recovery after a provider context-overflow error.

Today that reason is emitted on Pi's lower-level session stream, but it is not passed through to extension compaction events. That forces pi-multiloop to guess using timing, `agentRunning`, `lastInputAt`, and `customInstructions`.

The upstream API should look roughly like:

```ts
type CompactionReason = "manual" | "threshold" | "overflow";

session_before_compact.reason: CompactionReason
session_compact.reason: CompactionReason
```

Implementation shape in Pi core:

- In manual `AgentSession.compact(customInstructions)`, emit extension events with `reason: "manual"`.
- In `_runAutoCompaction(reason, willRetry)`, forward the existing `reason` argument into both extension events.
- Update extension event TypeScript definitions and docs.

Then pi-multiloop can define policy directly:

- `threshold` or `overflow` during/following a loop-owned turn: resume;
- `manual`: usually do not auto-resume unless the user explicitly asks;
- `manual` with custom instructions: never auto-resume unless those instructions request it.

This is cleaner than monkeypatching Pi internals or installing another `@mariozechner/pi-coding-agent` copy inside pi-multiloop. The active harness is the global `pi` CLI process; a package dependency copy would not change its runtime behavior. A monkeypatch may be possible for local experiments, but it would rely on private paths/prototypes and should not be pi-multiloop's shipped solution.

## Manual compaction mitigation ideas

A secondary sanity check would be to keep the last submitted user command and suppress auto-resume when it is `/compact` or starts with `/compact `. This would work only if Pi exposes built-in slash-command submissions to extensions, or if extension `input` starts firing before built-in command handling. In current interactive flow, built-in `/compact` is handled before `AgentSession.prompt()`, so pi-multiloop's `input` handler likely cannot see bare `/compact` today.

A partial check available today:

- If `session_before_compact.customInstructions` is defined, treat it as manual and suppress compaction resume.
- This does not catch bare `/compact`.

## Proposed compaction policy

A less surprising policy than the current 5 second heuristic:

1. Resume only if there is at least one attached/running loop.
2. Resume if compaction happened while `agentRunning === true` and the turn was loop-owned.
3. Resume if Pi emits threshold/overflow compaction immediately after a loop-owned `agent_end` and no normal user input happened in between.
4. Do not resume for known manual compaction.
5. Do not resume if there are pending user messages.
6. If classification is ambiguous, prefer not to auto-resume and leave the loop attached/running for explicit `/multiloop status` or `/multiloop resume` guidance.

This moves pi-multiloop from timing guesses toward explicit ownership and user-control boundaries.
