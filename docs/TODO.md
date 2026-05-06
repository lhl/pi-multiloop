# TODO

Future work tracked here. Current version: 0.2.0.

## v0.2 candidates

### Guard command: warn-on-fail in multiloop_measure

Guard is advisory today (agent sees it in the prompt, runs it voluntarily). Works fine — if the agent skips it and measures a broken build, the metric tanks, the loop reverts, and it learns. Self-correcting.

For v0.2, consider a lightweight middle ground: `multiloop_measure` optionally runs the guard before measuring. On failure, warn but don't block:

```
Guard check: `npx tsc --noEmit` → FAIL (exit 1)
⚠️ Guard failed — measurement may be invalid.
Metric: 0.123  MAD: 0.001  Confidence: HIGH
```

Agent still gets the measurement and decides. Keeps the extension from owning execution policy while reducing the "forgot to guard" failure mode. Don't enforce — enforcing turns the extension into a test runner (violates north star: don't own the benchmark script).

### Tests for loop.ts, modes.ts, ui.ts

lanes.ts, state.ts, and metrics.ts have good coverage (43 tests). loop.ts (decision/escalation logic), modes.ts (detection/punchlist parser), and ui.ts (dashboard rendering) have none. loop.ts is the highest priority since escalation bugs are hard to catch manually.

### Status enum consistency

LoopState.status and RegistryEntry.status use different terms for the same states:

| State status | Registry status | When |
|---|---|---|
| "running" | "active" | Normal operation |
| "stopped" | "completed" | Stop or escalation exhaustion |
| "paused" | "paused" | Paused |
| "archived" | "archived" | Archived |

Not a bug (different layers, different semantics) but confusing. Consider aligning them or documenting the mapping explicitly.

### CI / trusted publishing

Currently manual publish via `npm publish`. textguard and shisad use GitHub Actions with trusted publishing (OIDC) to PyPI. Could set up equivalent for npm — publish on tag push.

## Ideas (no timeline)

- One-line active-loop TUI element above the prompt, so attached/running loops remain visible without using the passive startup resume notice.
- Composite modes (e.g., punchlist where each item is an optimize sub-loop)
- `multiloop_iterate` persistence (save "attempt started" to disk for crash recovery)
- Lane-level `.gitignore` hints (auto-suggest ignoring `.multiloop/` on first run)
