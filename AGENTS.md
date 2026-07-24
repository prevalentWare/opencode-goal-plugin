# Agent Notes

## Project shape

`slash-goal-for-opencode` is an OpenCode v1 plugin with separate server and TUI entrypoints:

- `src/server.ts`: `/goal`, the three native-aligned public tools, hooks, task deferral, model/agent pinning, and idle continuation.
- `src/state.ts`: per-session goal lifecycle, usage accounting, legacy-state migration, and atomic persistence.
- `src/prompts.ts`: continuation, objective-update, budget-limit, Plan-mode, and compaction steering aligned to current native Codex.
- `src/tui.ts`: optional OpenTUI sidebar and command-palette UI.
- `test/`: state, server hooks/tools/commands, package, and TUI tests.
- `COMPATIBILITY.md`: supported OpenCode/API versions and the unavoidable command-turn gap.

## Invariants

- Keep the model-facing tool set exactly `get_goal`, `create_goal`, and `update_goal` unless native Codex changes.
- Keep statuses `active`, `paused`, `blocked`, `usageLimited`, `budgetLimited`, and `complete`. `unmet` is accepted only as a persisted legacy migration value.
- `create_goal` requires an explicit goal request; token budget is optional only when explicit.
- The model may update only `complete` or `blocked`. User/runtime code owns edit, pause, resume, clear, and limit states.
- Blocked requires at least three turns in the current run; resuming resets the audit.
- Preserve Plan-mode safety, task/subagent deferral, compaction context, and agent/provider/model pinning.
- Do not add an arbitrary default auto-turn or no-progress cap.
- State writes remain same-directory atomic replacements with Windows transient-lock handling. Tests must use `OPENCODE_GOAL_STATE_PATH`.
- Do not patch OpenCode source or modify a live OpenCode configuration as part of ordinary repository validation.

## Local validation

Run the complete gate for release-level changes:

```powershell
bun install
bun run lint
bun run typecheck
bun test
bun run build
bun run pack:dry-run
```

Confirm the package contains `dist/server.js`, `src/tui.ts`, `README.md`, `COMPATIBILITY.md`, `NOTICE`, and `LICENSE`.

## Compatibility

The peer range is `@opencode-ai/plugin >=1.17.1 <2`. The local compatibility targets are installed OpenCode `1.17.17` and current stable `@opencode-ai/plugin` `1.18.x`. Recheck both the hook types and behavior tests before changing the range.

## Publishing

The repository currently keeps only an `upstream` remote for the original Prevalentware project. Add the user's publication remote separately; do not rename or overwrite `upstream`. Update package repository/homepage/bugs metadata only after the final GitHub owner and URL are known.
