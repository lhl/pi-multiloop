# pi-multiloop — Workflow Review Feedback

A walkthrough of the repo as both a first-time user and an agent operating
inside an active loop, looking for confusing surfaces, surprises, or things
that look likely to bite in practice.

## Section 1 — Initial Walkthrough (2026-05-07)

This section is the first pass: read README → skill → extension code → docs,
imagining the path a user and an agent take through the system, and noting
points where intent and behavior diverge or where the surface is rougher than
it needs to be.

### A. Surface mismatches between docs and code

1. **"TUI dashboard" is overpromised.**
   `README.md:24` and `docs/PLAN.md` advertise a "TUI dashboard with live
   status and metric history per lane", and `ui.ts` does build a real columnar
   table (`formatDashboardText` at `extensions/pi-multiloop/ui.ts:49-81`,
   plus per-lane `formatLoopSummary`). But nothing in `index.ts` actually
   renders that widget. The real dashboard surface today is:
   - the one-line `ctx.ui.setStatus(...)` written in `updateStatus`
     (`index.ts:1446-1454`),
   - the `multiloop-resume` startup notice rendered via `Text`,
   - and the markdown blob `/multiloop status` emits via
     `buildIterationContext` (`loop.ts:205-271`).
   No call site references `buildDashboardRows` or `formatDashboardText`. A
   user expecting an in-pi widget after starting two loops will instead see a
   single "multiloop: perf#3, quant#1" status line. Either wire the dashboard
   widget up or soften the README copy.

2. **`/multiloop status` and the "dashboard" use different formats.**
   `showStatus` (`index.ts:1093-1126`) emits a multi-line markdown chunk per
   loop. The dashboard helpers in `ui.ts` produce a fixed-width table. Two
   render styles for what is conceptually the same view; nothing routes the
   user to one or the other.

3. **CHANGELOG/version drift.**
   `package.json` is at `0.2.0` (commit `ad56481`), but the two big v0.2
   features land *after* it: compound verification checks (`2721e0b`) and the
   guided loop setup (`151493b`). `CHANGELOG.md` keeps them under
   `## Unreleased`. A user reading "What's in 0.2.0?" will not find them. A
   real `0.2.x` (or `0.3.0`) release is implied but not committed, so
   `pi install npm:pi-multiloop` does not yet match the README.

4. **`docs/PLAN.md` checklist still shows everything unchecked.**
   The implementation checklist at `docs/PLAN.md:55-67` has 12 unchecked items
   for work that is clearly done (lanes/state/metrics/loop/modes/index/ui/
   skill plus tests). A new contributor reading PLAN first will assume the
   project is unbuilt.

### B. Command surface is inconsistent

5. **Argument shapes differ across subcommands** (all in `index.ts:1207-1402`):

   | Command | Accepts | Notes |
   |---|---|---|
   | `stop [lane]` | lane name (no run-tag) | filters by lane |
   | `pause [lane]` | lane name (no run-tag) | filters by lane |
   | `resume <id>` | requires `lane/run-tag` | bare lane fails |
   | `rm <id>` | requires `lane/run-tag` | bare lane fails |
   | `archive [id]` | bare = archive-all-eligible; arg must be `lane/run-tag` | a bare lane fails |
   | `ls` / `status` | none | |

   Three different shapes (`lane`, `lane/runTag`, none) for what feels like
   the same concept. Users who try `/multiloop resume perf` or
   `/multiloop archive perf` will hit "Invalid lane/run-tag" errors despite
   `pause perf` and `stop perf` working.

6. **Lane-only resume would be the natural shortcut.**
   When a lane has exactly one resumable run, `/multiloop resume <lane>`
   should just pick it. Today it errors. This is the friendliest UX win on
   the command surface.

7. **Run-tag format is awkward to retype.**
   `generateRunTag()` produces `run-YYYYMMDD-HHMMSS`
   (`lanes.ts:139-144`). The startup notice helps, but anyone resuming from a
   second terminal is going to alt-tab to the registry. A short id (e.g.
   `r-3a9f`) or `lane@N` would be friendlier.

### C. Inline `/multiloop <goal>` foot-guns

8. **Default lane = mode name → silent collisions.**
   The fallback in `index.ts:1404-1406` sets `lane = mode` when no
   `lane:` is present in the inline goal. Two `/multiloop improve …` calls
   without explicit lanes both land in lane `"optimize"`. They get distinct
   run-tags so the on-disk state is fine, but `findLane(...)` (`index.ts:1435-1444`)
   matches by lane name and returns the first one. The second loop becomes
   unreachable via tools until it's resumed by run-tag. The README explicitly
   advertises starting a second loop in the same worktree (`README.md:48-52`),
   so this collision is on the happy path.

9. **The whole inline string becomes the goal.**
   `goal: trimmed` (`index.ts:1422`) stores the full prompt — including the
   `verify: \`...\``, `guard: \`...\``, `prompt verifier: \`...\`` fragments.
   Goal text shown in `loopSummary` and resume prompts is therefore noisy.
   Consider stripping the parsed key/value parts before persisting the goal.

10. **`extractQuotedOption` handles backticks and double quotes only.**
    Single quotes — natural in shell-style prose — are silently ignored. So
    `/multiloop improve latency, verify: './bench.py'` falls back to the
    literal default verify command `echo 'TODO: set verify command'`
    (`index.ts:1407`) without any warning.

### D. Mode behavior is uneven

11. **Punchlist mode has no convergence wiring.**
    `modes.ts` exports `parsePunchlist`, `nextUncheckedItem`, `checkOffItem`,
    and `punchlistProgress`, but none of those functions are imported or
    called in `index.ts` or `loop.ts`. The skill simply tells the agent
    "Read the checklist file, pick the next unchecked item, implement it,
    run guard, check it off." The README/skill claim "Done when all items
    pass" but there is no automated convergence — the agent must self-stop.
    Either wire `punchlistProgress` into a stop check inside `multiloop_log`
    when mode is `punchlist`, or remove the unused parser and document
    explicitly that punchlist is just a labeled dev loop.

12. **Punchlist + checks falls through to the optimize keep/revert path.**
    `assessAcceptance` (`verifiers.ts:70-101`) special-cases `research` and
    `dev` to recommend `log`. `punchlist` is not in that list, so a punchlist
    loop with a `guardCommand` will get `recommendedAction: "keep"` or
    `"revert"` based on metric improvement — likely not what a punchlist
    user wants, since checking off an item is the unit of progress, not
    metric movement.

13. **`hasMetric: true` for `punchlist` is misleading.**
    `modes.ts:23-30` advertises punchlist as having a metric, but the canonical
    punchlist signal is `progress = done/total`, which the engine never
    computes. Same for research/dev: the metric is real, but the *direction*
    field's "lower is better" default is meaningless for "log every result".

### E. Multi-doc duplication of the setup contract

14. **The setup-guide rules live in three places** that must be kept in sync:
    - `skills/multiloop/skill.md` (skill body),
    - `docs/LOOP_GUIDE.md` (longer human reference),
    - `buildSetupGuidePrompt()` in `extensions/pi-multiloop/index.ts:259-286`
      (what actually gets sent to the model).

    They already drift: `LOOP_GUIDE.md` lists "Rollback safety" and a stop
    condition guidance the runtime prompt does not mention; the skill says
    "Acceptance policy: metric must improve **and** every check passes" and
    the runtime prompt says "metric improves **and** every check passes"
    while `verifiers.ts` formats it as "metric ... improved/did not improve;
    all checks passed/failed checks: ...". Pick one canonical phrasing and
    have the others reference it.

### F. Compound-verifier flow is strict in surprising ways

15. **`multiloop_decide` requires exact-array measurements equality.**
    `sameMeasurements` (`index.ts:77-79`) does element-wise equality. If the
    agent re-measures (e.g., to bump confidence) between `multiloop_measure`
    and `multiloop_decide`, the decide call will be rejected with a
    "Measurement mismatch" message and the agent has to call measure again.
    Documented in the error string, but easy to trip on. A tolerant variant
    that accepts "agent passed the recorded array OR a fresh array, in which
    case re-record" would be friendlier.

16. **Synthetic-failed-check pattern is hidden until you read the code.**
    `ensureRequiredChecks` (`verifiers.ts:30-68`) silently injects a
    `passed: false` check when a configured guard or prompt verifier is not
    represented in `multiloop_measure.checks`. Good safety; not surfaced in
    the README, only in the skill. A first-time agent will see "Acceptance:
    FAIL — failed checks: guard" and not know that an empty `checks: []` was
    treated as "guard didn't run". Add an explicit message like
    "Configured guard not reported; treated as failed. Re-run guard and call
    multiloop_measure again."

### G. Auto-continuation has subtle edge cases

17. **`loopTurnActive` is set on every loop tool, then resume happens after
    `agent_end`.**
    Together this means: any loop-tool turn ends → another follow-up prompt
    is queued unless the user types something or the loop is paused/stopped.
    If the agent says "I'm wrapping up for the day" without calling
    `/multiloop pause`, it will be prodded into another iteration. The skill
    tells the agent not to ask "should I continue?" mid-approved loop, but
    a graceful "stop here" without an explicit slash command is hard.

18. **`shouldContinueAfterUserInput` regex misses ambiguous suspensions.**
    The regex (`index.ts:81-91`) matches `stop|pause|halt|...` only when
    paired with `loop|multiloop|iteration|work`, plus a `do not continue`
    branch. Plain "let's hold on" / "wait" / "let me think" do not clear
    `loopTurnActive`, so the auto-continue fires anyway. Consider widening
    or, better, requiring an explicit slash command to stop auto-continue
    (and make the auto-continue more conservative when in doubt).

### H. State / registry status terminology

19. **Snapshot vs registry status disagree by design.**
    Already filed in `docs/TODO.md` and explained in `docs/STATE.md`: state
    `running` ↔ registry `active`, state `stopped` ↔ registry `completed`.
    For a user (or agent) inspecting raw files, the same loop appearing as
    `active` in `registry.json` and `running` in `state.json` is needless
    cognitive load. Pick one vocabulary or document the mapping at the top
    of `state.json`/`registry.json` itself (a `_doc` field, or a comment in
    the README's "How State Works").

20. **`runningStates()` does not mean "agent is currently iterating".**
    It only means "attached AND `state.status === 'running'`" (`index.ts:68-70`).
    `STATE.md` calls this out, but it bites in the auto-continue logic where
    it is the gating condition. Naming this `attachedRunningStates()` would
    reduce reader confusion.

### I. Smaller things

21. **`/multiloop archive someLane` (no slash) errors out.** Inconsistent
    with `pause`/`stop`. Either accept lane-only and archive all matching
    runs, or document the asymmetry in `help`.
22. **Help text doesn't list `guide` / `wizard` / `setup` aliases**
    (`index.ts:1364-1367`). They work, but only `index.ts` knows.
23. **`docs/STATE.md` is excellent design rationale but is not linked
    from README**. New contributors will not find it.
24. **`tests/verifiers.test.ts` is 80 lines** (`tests/verifiers.test.ts`),
    light coverage for what is now the central acceptance logic. Add cases
    for: missing-guard synthetic check, prompt-verifier-only configurations,
    research/dev mode falling through to `log`, and punchlist behavior once
    decided.
25. **No tests cover the `/multiloop` command handler** itself — only the
    pure helpers it builds. Argument parsing (`extractQuotedOption`,
    `parseLaneId` via the dispatcher) is the surface most likely to break
    with each new subcommand.
26. **`CLAUDE.md` is a symlink to `AGENTS.md`.** Fine for Claude Code
    consumers, but pi convention is `AGENTS.md` only. Worth a one-liner in
    `AGENTS.md` clarifying which doc is canonical.

### J. What the workflow gets right

For balance — these are the parts that read clean on a first pass:

- **The non-negotiables in `AGENTS.md`** (commit per logical unit, no
  `git add .`, where files live) are short and enforceable.
- **The append-only `results.jsonl` + overwrite `state.json` split** is a
  clean separation of "ground truth history" vs "resume snapshot", and
  `reconstructState` (`state.ts:126-166`) is small and easy to audit.
- **`MAD + threshold * mad`** in `isImprovement` (`metrics.ts:79-95`) is
  a simple, defensible significance gate that handles GPU jitter.
- **The `activeIteration` phase machine** (`started` → `measured` →
  cleared on decide/log) plus the decide-action mismatch guard
  (`index.ts:919-950`) is the right shape for "you can't keep what you
  haven't verified".
- **The startup resume notice with theme-aware coloring** is a nice
  passive-but-discoverable surface; not auto-attaching loops on session
  start is the right default.
