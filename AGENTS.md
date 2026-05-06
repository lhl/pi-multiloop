# pi-multiloop — Agent Guide

Pi extension for multi-lane autonomous iteration loops. Supports optimization, punchlist, research, and dev modes with lane-isolated state on a single worktree.

## Non-Negotiables

1. **Commit after every logical work unit.** Do not wait to be asked.
2. **Never use `git add .`, `git add -A`, or `git commit -a`.** Stage files explicitly by name.
3. **Extension code goes in `extensions/pi-multiloop/`.** Skills go in `skills/`. Tests go in `tests/`.

## Summary

- Primary purpose: pi extension package (npm: `pi-multiloop`)
- Source-of-truth docs: `docs/PLAN.md` (project plan + north stars), `README.md` (user-facing docs)
- Extension entry point: `extensions/pi-multiloop/index.ts`
- Skill: `skills/multiloop/skill.md`

## Key Files

| Path | Purpose |
|---|---|
| `package.json` | Pi package manifest + npm metadata |
| `extensions/pi-multiloop/index.ts` | Extension entry point — events, tools, commands |
| `extensions/pi-multiloop/lanes.ts` | Lane/run-tag path resolution and registry |
| `extensions/pi-multiloop/state.ts` | JSONL log + JSON snapshot persistence |
| `extensions/pi-multiloop/metrics.ts` | Metric parsing and MAD confidence scoring |
| `extensions/pi-multiloop/loop.ts` | Core iterate/keep/revert/escalation engine |
| `extensions/pi-multiloop/modes.ts` | Mode definitions and punchlist parser |
| `extensions/pi-multiloop/ui.ts` | TUI dashboard widget |
| `skills/multiloop/skill.md` | Setup wizard skill prompt |
| `docs/PLAN.md` | North stars, gap analysis, implementation checklist |

## Architecture

### Lane Isolation

All state lives in a single `.multiloop/` directory at repo root:
```
.multiloop/
├── registry.json
├── active/<LANE>/<RUN_TAG>/
│   ├── results.jsonl    # Append-only iteration log
│   ├── state.json       # Resume snapshot
│   └── lessons.md       # Cross-run learning (optional)
└── archive/             # Completed loops moved here
```

### Pi Extension API Usage

- Events: `input`, `agent_start`, `session_before_compact`, `session_compact`, `agent_end`
- Tools: `multiloop_iterate`, `multiloop_measure`, `multiloop_decide`, `multiloop_log`
- Commands: `/multiloop` (with subcommands: status, ls, stop, pause, resume, archive, rm, help)
- UI: Widget for lane status dashboard

### Testing

```bash
npm install
npx vitest run
```

## Verification

| Scope | Check |
|---|---|
| Build | `npx tsc --noEmit` passes |
| Tests | `npx vitest run` passes |
| Install | `pi install .` loads without errors |
| Extension | `/multiloop status` shows "no active loops" |

## Git Discipline

Same as devstack — commit immediately on logical completion, stage explicitly, conventional prefixes (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`).
