# Agent Notes

## Project Shape

This package is an OpenCode plugin with separate server and TUI entrypoints:

- `src/server.ts` is the server plugin. It registers the `/goal` command, goal tools, chat/session hooks, usage accounting, compaction context, and idle auto-continuation.
- `src/state.ts` owns goal persistence and lifecycle state. It stores JSON at `OPENCODE_GOAL_STATE_PATH` when set, otherwise under the user's OpenCode data location.
- `src/tui.tsx` is the Solid/OpenTUI sidebar and command-palette UI. It is exported as source, so avoid adding heavy runtime dependencies here unless there is a strong reason.
- `src/prompts.ts` contains the goal-mode continuation/system/compaction prompts.
- `test/` covers state, server hooks/tools, and TUI behavior with Bun tests.

## Change Guidelines

- Preserve the public Promise-based state API (`getGoal`, `createGoal`, `completeGoal`, etc.) because OpenCode hooks and tests call it directly.
- Keep `zod` for OpenCode tool argument schemas unless the OpenCode plugin API explicitly supports another schema format.
- Effect is intentionally used in the state/persistence boundary. Do not spread Effect into the TUI unless the benefit clearly outweighs the extra runtime footprint.
- If server code imports a runtime dependency that should be resolved from `dependencies`, externalize it in the Bun build script so the package does not silently bundle it.
- State writes should remain atomic: write to a temp file, then `rename` into place.
- Use `OPENCODE_GOAL_STATE_PATH` for tests and smoke runs so you do not touch a real user's goal state.

## Local Validation

Before treating a code change as complete, run the relevant checks. For release-level changes, run the full local gate:

```bash
bun run lint
bun run typecheck
bun run test
bun run build
bun run pack:dry-run
```

`bun run build` writes `dist/server.js`. The package only publishes `dist`, `src/tui.tsx`, `LICENSE`, and `README.md`, so confirm `npm pack --dry-run` includes what runtime installation needs.

## Publishing Flow

This repo publishes from GitHub Actions on pushes to `main`. The workflow computes the next patch version from npm, builds, publishes, and creates a GitHub release.

After pushing a release change, monitor the workflow with `gh run list --branch main` and `gh run watch <run-id> --exit-status`. Verify the release and package metadata after success:

```bash
npm view @prevalentware/opencode-goal-plugin version dependencies
gh release view v<version>
```

## End-To-End Plugin Test

To test this plugin end to end, do not stop at unit tests. Run the local gates first: `bun run lint`, `bun run typecheck`, `bun run test`, `bun run build`, and `bun run pack:dry-run`.

After publishing, verify the exact npm version with `npm view @prevalentware/opencode-goal-plugin version dependencies`. Install that version in an isolated temp OpenCode project with `opencode plugin @prevalentware/opencode-goal-plugin@<version>`, run `opencode debug config` to confirm the package is loaded and the `goal` command is registered, then run a smoke test with an isolated state file, for example:

```bash
OPENCODE_GOAL_STATE_PATH="/tmp/opencode-goal-plugin-smoke/goals.json" opencode run "/goal create a smoke-test goal and then report the current goal state"
```

The smoke test should show `create_goal` and `get_goal` tool calls and report an active goal. Inspect the state file afterward if you need to confirm JSON persistence.
