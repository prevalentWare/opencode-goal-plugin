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

- `/goal <objective>`, `/pause_goal`, and `/resume_goal` as OpenCode commands for TUI, desktop, web, and remote integrations that expose the server command catalog.
- A sidebar goal indicator with status, elapsed time, and objective.
- Agent tools: `get_goal`, `get_goal_history`, `list_all_goals`, `create_goal`, `set_goal`, `update_goal_objective`, `update_goal_status`, `update_goal`, and `clear_goal`.
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

Choose the instructions that match the CLI you run:

| OpenCode version | How to identify it | Instructions |
| --- | --- | --- |
| OpenCode 1 stable | You run `opencode` and `opencode --version` prints `1.x` | [OpenCode 1](#opencode-1-stable) |
| OpenCode 2 beta | You run `opencode2` | [OpenCode 2](#opencode-2-beta) |

Do not mix the configuration formats. OpenCode 1 uses `plugin` and `tui.json`; OpenCode 2 uses `plugins` and the global `cli.json`.

### OpenCode 1 Stable

Install for the current project:

```bash
opencode plugin @prevalentware/opencode-goal-plugin
```

Install globally:

```bash
opencode plugin -g @prevalentware/opencode-goal-plugin
```

OpenCode detects both package entrypoints and writes the plugin into the server and TUI config targets.

For manual installation, add the package to both V1 config files.

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

### OpenCode 2 Beta

Use this section only when running `opencode2`. Plugin release `0.1.30` and newer supports OpenCode 2 preview `0.0.0-next-17055` while remaining compatible with OpenCode 1.

Add the package to both V2 plugin lists:

`opencode.json`:

```json
{
  "plugins": ["@prevalentware/opencode-goal-plugin"]
}
```

`~/.config/opencode/cli.json`:

```json
{
  "plugins": ["@prevalentware/opencode-goal-plugin"]
}
```

OpenCode 2 does not read the V1 `tui.json` file. The server entrypoint comes from `opencode.json`, while the sidebar and palette integration come from `~/.config/opencode/cli.json`.

OpenCode 2 plugin APIs are still beta. This package pins its V2 development contract to the preview version above; later previews may require a compatible plugin update. V2 currently supports the goal command, tools, persistent state, usage accounting, idle continuation, Plan-mode safety, and TUI sidebar/palette integration. Goal-specific compaction context and recovery of already-running child sessions after a plugin restart remain V1-only because the current V2 plugin context does not expose equivalent hooks or history queries.

## Options

In OpenCode 1, server options use the package-and-options tuple in `opencode.json`:

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
        "max_turn_time": 300,
        "max_prompt_failures": 3,
        "default_token_budget": 200000,
        "max_goal_duration_seconds": 1800,
        "no_progress_token_threshold": 50,
        "max_no_progress_turns": 2,
        "restricted_agents": ["plan"],
        "allow_goal_execution_from_plan": false,
        "max_objective_chars": 100000
      }
    ]
  ]
}
```

In OpenCode 2, use the plugin object form instead:

```json
{
  "plugins": [
    {
      "package": "@prevalentware/opencode-goal-plugin",
      "options": {
        "auto_continue": true,
        "max_auto_turns": 25,
        "default_token_budget": 200000,
        "restricted_agents": ["plan"]
      }
    }
  ]
}
```

Defaults:

- `auto_continue`: `true`
- `defer_while_tasks_active`: `true`; when enabled, goal auto-continuation waits for active OpenCode Task child sessions and their orchestrator reconciliation before sending the next goal prompt.
- `max_auto_turns`: `25`
- `min_continue_interval_seconds`: `3`
- `max_turn_time`: unset by default; set a positive number of seconds to retry one active-goal continuation prompt when a model turn remains busy for that long. Each new busy event resets the watchdog. Idle, built-in retry, session deletion, active Task children, and restricted agents suppress the retry. Watchdog retries are independent of `min_continue_interval_seconds` and never consume auto-turn or no-progress budgets, but recognized transport failures still count toward the `max_prompt_failures` ceiling.
- `max_prompt_failures`: `3`; consecutive transport or no-response continuation failures pause the goal at this ceiling. Prompt delivery alone does not reset the count; substantive assistant or tool progress, a new goal, or an explicit resume does.
- `default_token_budget`: unset by default; when set, new goals inherit this token budget.
- `max_goal_duration_seconds`: unset by default; when set, new goals inherit this elapsed-time safety limit.
- `no_progress_token_threshold`: `50`; output-token floor used to judge whether a goal continuation turn made progress.
- `max_no_progress_turns`: `2`; consecutive low-progress goal continuation turns before pausing. Only turns produced by a reserved goal continuation count — ordinary low-output assistant messages (for example short tool-call-only turns from PTY or status checks) never increment this counter.
- `register_command`: `true`; registers `/goal`, `/pause_goal`, and `/resume_goal`.
- `command_name`: `"goal"`; renames the main goal command only. The reserved names `pause_goal` and `resume_goal` fall back to `goal` so the standalone controls remain available.
- `restricted_agents`: `["plan"]`; agents (matched case-insensitively) treated as planning-only for goal execution.
- `allow_goal_execution_from_plan`: `false`; when `true`, disables Plan-mode goal restrictions entirely.
- `max_objective_chars`: `100000`; maximum Unicode code-point length of the submitted goal objective, completion evidence,
  and blocker text. The previous 4000-character cap was a defect, not a compatibility constraint. The same limit is
  advertised on V1 and V2 tool schemas and enforced at runtime, independently per plugin instance. Accepted values are
  trimmed before persistence. Large objectives are echoed into continuation and compaction prompts.

## Goal Workflow

Use `/goal <objective>` in a fresh OpenCode chat to create a long-running goal:

```text
/goal review the frontend and translate visible English UI text to Spanish
```

Bare `/goal` reports the current goal state. `/goal history` reports lifecycle history and recent checkpoints. `/goal edit <objective>` updates the current objective. `/goal pause` pauses the goal without clearing it, and `/goal resume` resumes it. The standalone `/pause_goal` and `/resume_goal` controls are discoverable by remote integrations that expose OpenCode's server command catalog. Their arguments and resolved attachments are removed before composing the goal-control prompt, although OpenCode V1 may evaluate its own command syntax before plugin hooks run. `/pause_goal` persists the pause before its acknowledgement turn starts, preventing a later idle event from starting another continuation. It cannot cancel a continuation that was already delivered or whose delivery was already in flight when the pause was committed. Pausing a goal that is already `budgetLimited` or `usageLimited` preserves that safety status; resuming a closed `complete` or `unmet` goal is rejected. `/goal clear` clears the goal; `/goal stop`, `/goal off`, `/goal reset`, `/goal none`, and `/goal cancel` are clear aliases. The TUI also includes a `Goal` command-palette entry for viewing, refreshing, pausing, resuming, showing history, or clearing the current goal state without creating a new goal.

You can also ask the agent to formulate the objective and call `set_goal` itself, for example: "set your own goal to finish this refactor safely." The tool uses the agent-written objective but still only creates a goal when explicitly requested.

When writing the objective, include the scope, non-goals, and verification path when they matter. The agent is reminded to audit real files, command output, tests, or PR state before closing the goal.

The `update_goal` tool can close a goal in two ways:

- `status: "complete"` with `evidence` when every requirement is actually achieved.
- `status: "unmet"` with `blocker` when the objective cannot be achieved or is blocked by missing external input.

The plugin also uses safety states while keeping the goal available for review or resume:

- `budgetLimited` when a token budget is exhausted.
- `usageLimited` when an auto-turn or elapsed-time budget is exhausted.
- `paused` when the user pauses, auto-continue repeatedly fails, or repeated low-progress goal continuation turns are detected. No-progress accounting is scoped to goal continuation turns: each reserved continuation is evaluated once, when its turn completes, and unrelated assistant activity in the session never pauses the goal.

When a safety limit is reached, the plugin sends one wrap-up prompt asking for a concise handoff instead of silently continuing forever.

## Plan Mode Safety

OpenCode Plan mode is a user-controlled safety boundary, and goal mode must not become an escape hatch out of it. The plugin enforces that boundary in several layers:

- Goals created with `create_goal` or `set_goal` from the `plan` agent are recorded as `paused` with stop reason `plan mode`, never as active implementation goals. The tool response tells the agent to ask the user to switch to Build mode and resume the goal.
- Automatic idle continuation is suppressed while the last user prompt or the latest assistant turn came from a restricted agent. If a previously active goal idles under Plan mode, it is paused visibly instead of continuing autonomously.
- Resuming a goal (`update_goal_status` with `active`, or `update_goal_objective` with `status: "active"`) is refused from Plan mode, so a prompt-injected instruction inside repository content cannot self-escalate a planning session into Build-mode execution. Switching to Build mode and resuming is an explicit user action; resuming from Build updates the tracked agent so continuation restarts pinned to Build.
- Continuation prompts are pinned to the agent recorded from the last user prompt (`body.agent`), so auto-continue never silently switches the session to a different agent or mode.
- Every session receives the same compact Goal Mode system policy, regardless of whether a goal exists or which lifecycle state it is in. Dynamic objectives, limits, counters, and stop details stay in goal-tool results, continuation prompts, and compaction context; Plan-mode and safety-limit enforcement remains server-side.

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

The state file is written atomically through a same-directory temp file: the final path is only ever replaced by a fully-flushed file, so after a crash the state is the previous or the new valid version, never a torn one. The file is created with owner-only permissions where the host filesystem supports them, and the temp name is a random UUID opened exclusively so concurrent writers cannot collide.

Ordinary fsync improves crash consistency but is not `F_FULLFSYNC`, so sudden power loss on macOS/APFS is not an absolute durability guarantee; where the platform cannot fsync the parent directory, a crash may leave the old or the new state file (both valid), never a partially-written one. Existing active goals recover from disk with their full objective, budget, history, and checkpoint metadata.

If the rename succeeds but syncing the parent directory reports a genuine I/O error, the mutation reports a write failure even though the new valid state may already be present. This avoids claiming durability that the filesystem did not confirm.

If a non-empty state file contains only whitespace, a UTF-8 BOM, or NUL bytes after an interrupted write, the next mutation preserves its exact contents beside the state file as `goals.json.corrupt-<timestamp>-<uuid>` before writing recovered state. If another process replaces the state during recovery, the mutation refuses to overwrite that newer content. If the quarantine copy itself cannot be created, the plugin reports the failure and continues recovery rather than making every prompt fail indefinitely. OpenCode 1 also records the quarantine outcome and path through its application log so the data-loss event remains discoverable.

## Credits

This plugin follows Codex's native goal-mode semantics where OpenCode plugin hooks allow it. Several hardening ideas were adapted from William Ricchiuti's [`willytop8/OpenCode-goal-plugin`](https://github.com/willytop8/OpenCode-goal-plugin), especially lifecycle history, checkpoints, no-progress safeguards, budget wrap-up behavior, and strict-provider-safe system prompt merging. Thank you, William.

## Development

```bash
bun install
bun run test
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
    "./tui": "./src/tui.ts"
  }
}
```

Codex goal mode has deeper runtime integration for thread lifecycle control. This plugin implements the same workflow using OpenCode plugin hooks. Token usage is read from OpenCode step-finish usage when available and falls back to message token metadata or text estimation when exact usage is unavailable. Continuation is driven by OpenCode idle events, including `session.idle` and `session.status` idle notifications. The optional `max_turn_time` watchdog can retry one goal continuation prompt when a model turn remains busy, without consuming the goal's auto-turn, no-progress, or prompt-failure budgets. By default, continuation is deferred while OpenCode Task child sessions are active or their terminal result still needs an orchestrator turn. During compaction, the plugin disables OpenCode's generic synthetic auto-continue while an active goal exists so the goal-specific continuation prompt remains authoritative.

The goal sidebar shows the current status, elapsed time, token usage, auto-continue count, latest checkpoint, latest status message, stop reason, and objective when a goal is active, paused, or safety-limited. Closed goals remain visible briefly through the latest tool state as achieved or unmet.
