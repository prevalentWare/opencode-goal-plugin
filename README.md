# OpenCode Goal Plugin

[![npm version](https://img.shields.io/npm/v/@prevalentware/opencode-goal-plugin.svg)](https://www.npmjs.com/package/@prevalentware/opencode-goal-plugin)
[![GitHub repository](https://img.shields.io/badge/GitHub-prevalentWare%2Fopencode--goal--plugin-blue?logo=github)](https://github.com/prevalentWare/opencode-goal-plugin)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

OpenCode Goal Plugin adds Codex-style long-running goal mode to OpenCode. It gives AI coding agents a `/goal` slash command, persistent goal state, completion evidence, idle continuation, and a terminal UI goal indicator so an OpenCode session can keep working toward one explicit objective until it is complete, blocked, or cleared.

If you are searching for an OpenCode goal plugin, goal mode for OpenCode, or a way to keep an OpenCode AI coding agent focused on a long-running task, this package is the npm plugin for that workflow.

Links:

- npm package: [`@prevalentware/opencode-goal-plugin`](https://www.npmjs.com/package/@prevalentware/opencode-goal-plugin)
- GitHub repository: [`prevalentWare/opencode-goal-plugin`](https://github.com/prevalentWare/opencode-goal-plugin)
- OpenCode plugin command: `opencode plugin @prevalentware/opencode-goal-plugin`

The OpenCode Goal Plugin adds:

- `/goal <objective>` as an OpenCode command for TUI, desktop, and web.
- A sidebar goal indicator with status, elapsed time, and objective.
- Agent tools: `get_goal`, `get_goal_history`, `create_goal`, `set_goal`, `update_goal_objective`, `update_goal`, and `clear_goal`.
- Goal close evidence: `complete` requires verified evidence, and `unmet` requires a concrete blocker.
- Persistent per-session goal state with history, checkpoints, budgets, and owner-only file permissions.
- Optional automatic continuation on `session.idle` / `session.status`, with no-progress pause and budget wrap-up safeguards.
- Plan-mode safety: goals created from the `plan` agent stay paused, and auto-continue never escapes a Plan-mode session or switches agents on its own.
- Compaction context so active goals are preserved when OpenCode summarizes a long session.

## Why Use This OpenCode Goal Plugin?

Use this plugin when you want OpenCode to behave more like a goal-driven coding agent instead of a one-prompt assistant. A goal stays visible, survives session compaction, can continue automatically when the session becomes idle, and can only be closed with explicit evidence or a concrete blocker.

Common use cases:

- Keep an OpenCode agent focused during long refactors, migrations, reviews, or test-fixing sessions.
- Track one explicit objective across TUI, desktop, and web OpenCode surfaces.
- Require completion evidence before a goal is marked done.
- Preserve the current goal when OpenCode summarizes or compacts a long conversation.

## Install

Install locally for the current OpenCode project:

```bash
opencode plugin @prevalentware/opencode-goal-plugin
```

Install globally:

```bash
opencode plugin -g @prevalentware/opencode-goal-plugin
```

OpenCode detects both package entrypoints and writes the plugin into the server and TUI config targets.

## Manual Config

If you configure it manually, add the package to both config files.

`opencode.json`:

```json
{
  "plugin": ["@prevalentware/opencode-goal-plugin"]
}
```

`tui.json`:

```json
{
  "plugin": ["@prevalentware/opencode-goal-plugin"]
}
```

## Options

Server options can be configured in `opencode.json`:

```json
{
  "plugin": [
    [
      "@prevalentware/opencode-goal-plugin",
      {
        "auto_continue": true,
        "defer_while_tasks_active": true,
        "max_auto_turns": 25,
        "min_continue_interval_seconds": 3,
        "max_prompt_failures": 3,
        "default_token_budget": 200000,
        "max_goal_duration_seconds": 1800,
        "no_progress_token_threshold": 50,
        "max_no_progress_turns": 2,
        "restricted_agents": ["plan"],
        "allow_goal_execution_from_plan": false
      }
    ]
  ]
}
```

Defaults:

- `auto_continue`: `true`
- `defer_while_tasks_active`: `true`; when enabled, goal auto-continuation waits for active OpenCode Task child sessions and their orchestrator reconciliation before sending the next goal prompt.
- `max_auto_turns`: `25`
- `min_continue_interval_seconds`: `3`
- `max_prompt_failures`: `3`
- `default_token_budget`: unset by default; when set, new goals inherit this token budget.
- `max_goal_duration_seconds`: unset by default; when set, new goals inherit this elapsed-time safety limit.
- `no_progress_token_threshold`: `50`
- `max_no_progress_turns`: `2`
- `register_command`: `true`
- `command_name`: `"goal"`
- `restricted_agents`: `["plan"]`; agents (matched case-insensitively) treated as planning-only for goal execution.
- `allow_goal_execution_from_plan`: `false`; when `true`, disables Plan-mode goal restrictions entirely.

## Goal Workflow

Use `/goal <objective>` in a fresh OpenCode chat to create a long-running goal:

```text
/goal review the frontend and translate visible English UI text to Spanish
```

Bare `/goal` reports the current goal state. `/goal history` reports lifecycle history and recent checkpoints. `/goal edit <objective>` updates the current objective. `/goal pause` pauses the goal without clearing it, and `/goal resume` resumes it. `/goal clear` clears the goal; `/goal stop`, `/goal off`, `/goal reset`, `/goal none`, and `/goal cancel` are clear aliases. The TUI also includes a `Goal` command-palette entry for viewing, refreshing, pausing, resuming, showing history, or clearing the current goal state without creating a new goal.

You can also ask the agent to formulate the objective and call `set_goal` itself, for example: "set your own goal to finish this refactor safely." The tool uses the agent-written objective but still only creates a goal when explicitly requested.

When writing the objective, include the scope, non-goals, and verification path when they matter. The agent is reminded to audit real files, command output, tests, or PR state before closing the goal.

The `update_goal` tool can close a goal in two ways:

- `status: "complete"` with `evidence` when every requirement is actually achieved.
- `status: "unmet"` with `blocker` when the objective cannot be achieved or is blocked by missing external input.

The plugin also uses safety states while keeping the goal available for review or resume:

- `budgetLimited` when a token budget is exhausted.
- `usageLimited` when an auto-turn or elapsed-time budget is exhausted.
- `paused` when the user pauses, auto-continue repeatedly fails, or repeated low-output/no-progress turns are detected.

When a safety limit is reached, the plugin sends one wrap-up prompt asking for a concise handoff instead of silently continuing forever.

## Plan Mode Safety

OpenCode Plan mode is a user-controlled safety boundary, and goal mode must not become an escape hatch out of it. The plugin enforces that boundary in several layers:

- Goals created with `create_goal` or `set_goal` from the `plan` agent are recorded as `paused` with stop reason `plan mode`, never as active implementation goals. The tool response tells the agent to ask the user to switch to Build mode and resume the goal.
- Automatic idle continuation is suppressed while the last user prompt or the latest assistant turn came from a restricted agent. If a previously active goal idles under Plan mode, it is paused visibly instead of continuing autonomously.
- Resuming a goal (`update_goal_status` with `active`, or `update_goal_objective` with `status: "active"`) is refused from Plan mode, so a prompt-injected instruction inside repository content cannot self-escalate a planning session into Build-mode execution. Switching to Build mode and resuming is an explicit user action; resuming from Build updates the tracked agent so continuation restarts pinned to Build.
- Continuation prompts are pinned to the agent recorded from the last user prompt (`body.agent`), so auto-continue never silently switches the session to a different agent or mode.
- The goal system reminder becomes planning-only after a Plan-mode prompt: it shows goal state but instructs the agent not to perform implementation work.

The set of planning-only agents is configurable with `restricted_agents` (default `["plan"]`). Setting `allow_goal_execution_from_plan` to `true` opts out of all of these restrictions; the secure default is `false`.

## State

Goal state is stored at:

```text
$XDG_DATA_HOME/opencode-goal-plugin/goals.json
```

If `XDG_DATA_HOME` is not set, the default is:

```text
~/.local/share/opencode-goal-plugin/goals.json
```

Set `OPENCODE_GOAL_STATE_PATH` to use a custom file.

The state file is written atomically with owner-only permissions when the host filesystem supports it. Existing active goals recover from disk with their full objective, budget, history, and checkpoint metadata.

## Credits

This plugin follows Codex's native goal-mode semantics where OpenCode plugin hooks allow it. Several hardening ideas were adapted from Willy Topete's [`willytop8/OpenCode-goal-plugin`](https://github.com/willytop8/OpenCode-goal-plugin), especially lifecycle history, checkpoints, no-progress safeguards, budget wrap-up behavior, and strict-provider-safe system prompt merging. Thank you, Willy.

## Development

```bash
bun install
bun test
bun run lint
bun run typecheck
bun run build
npm pack --dry-run
```

## Publishing

This package is set up for npm Trusted Publishing from GitHub Actions. On every push to `main`, CI runs typecheck, lint, and unit tests in parallel. If they all pass, the publish job computes the next patch version from the latest version on npm, builds the package, and runs `npm publish`.

Before the first automated publish, configure the package on npm:

1. Open the package settings on npmjs.com.
2. Add a Trusted Publisher for GitHub Actions.
3. Use repository `prevalentWare/opencode-goal-plugin`.
4. Use workflow file `publish.yml`.

The repository must be public for npm provenance to be generated automatically.

## Notes

OpenCode plugin modules are target-specific. This package exports separate modules for server hooks/tools and TUI UI:

```json
{
  "exports": {
    "./server": "./dist/server.js",
    "./tui": "./src/tui.tsx"
  }
}
```

Codex goal mode has deeper runtime integration for thread lifecycle control. This plugin implements the same workflow using OpenCode plugin hooks. Token usage is read from OpenCode step-finish usage when available and falls back to message token metadata or text estimation when exact usage is unavailable. Continuation is driven by OpenCode idle events, including `session.idle` and `session.status` idle notifications. By default, continuation is deferred while OpenCode Task child sessions are active or their terminal result still needs an orchestrator turn. During compaction, the plugin disables OpenCode's generic synthetic auto-continue while an active goal exists so the goal-specific continuation prompt remains authoritative.

The goal sidebar shows the current status, elapsed time, token usage, auto-continue count, latest checkpoint, latest status message, stop reason, and objective when a goal is active, paused, or safety-limited. Closed goals remain visible briefly through the latest tool state as achieved or unmet.
