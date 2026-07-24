# slash/goal for OpenCode

`slash-goal-for-opencode` brings OpenAI Codex's native `/goal` workflow as close as the stable OpenCode v1 plugin API permits, without patching OpenCode.

It keeps one explicit objective attached to an OpenCode session, persists it across restarts and compaction, continues it when the session becomes idle, and applies strict completion and blocked audits. The public model-facing surface intentionally matches current Codex: `get_goal`, `create_goal`, and `update_goal` only.

## Native-aligned behavior

- Statuses: `active`, `paused`, `blocked`, `usageLimited`, `budgetLimited`, and `complete`.
- `create_goal` is allowed only after an explicit user/system/developer request. `token_budget` must be omitted unless a budget was explicitly requested.
- `update_goal` accepts only `complete` or `blocked`. Pause, resume, clear, objective edits, and limit states are not model-controlled.
- Completion uses the current Codex requirement-by-requirement evidence audit.
- `blocked` is rejected before three goal turns have elapsed in the current run; the steering text also requires the same blocker on all three turns and a genuine impasse.
- Resuming a blocked goal starts a fresh blocked audit.
- There is no arbitrary default auto-turn cap. `max_auto_turns` is opt-in.
- Idle continuations stay pinned to the last user-selected agent and provider/model.
- Active Task/subagent sessions defer continuation until their result has been reconciled by the parent session.
- Plan mode cannot be used as an implementation escape hatch. Goal execution pauses until the user switches to Build mode and resumes it.
- Interrupting an active OpenCode turn pauses goal continuation durably; duplicate idle events cannot restart it, and `/goal resume` is required to continue.
- Goal state and steering survive OpenCode compaction.
- New user prompts invalidate scheduled or in-flight idle continuations before another prompt can be injected.
- Runtime quota/rate-limit errors stop the goal as `usageLimited`. Connection, timeout, and empty-response failures receive at most `max_prompt_failures` consecutive automatic attempts (three by default), then pause until an explicit `/goal resume`; duplicate idle notifications cannot consume extra attempts. Other terminal turn errors stop as system-controlled `blocked`.

The alignment reference is the current [`codex-rs/ext/goal`](https://github.com/openai/codex/tree/main/codex-rs/ext/goal) implementation and its goal steering templates, reviewed on 2026-07-20.

## Commands

```text
/goal
/goal <objective>
/goal edit <replacement objective>
/goal pause
/goal resume
/goal clear
```

Bare `/goal` reads the current state. Only `edit`, `pause`, `resume`, and `clear` are reserved control words; every other nonempty argument is treated as an objective. For example, `/goal status` creates the objective `status` rather than invoking a hidden alias.

The command hook applies create/edit/pause/resume/clear directly before the model runs, so those user controls do not depend on the model choosing the correct tool. Bare `/goal edit` is non-mutating and reports the required `/goal edit <objective>` syntax.

## Public tools

| Tool | Model authority |
| --- | --- |
| `get_goal` | Read the current session goal and usage. |
| `create_goal` | Create an explicitly requested goal; optional explicit token budget only. |
| `update_goal` | Mark the current goal `complete` or, after the strict audit, `blocked`. |

There are deliberately no public `set_goal`, `clear_goal`, history, objective-edit, pause, or resume tools. Those are internal state operations controlled by `/goal` or the runtime.

## Usage accounting

Goal token usage is scoped to assistant work observed after the goal starts. For OpenCode messages, the native-aligned total is `input + output + reasoning`; cache read/write fields and ambiguous provider `total` fields are not charged. Repeated streaming, message-transform, event, and compaction observations are reconciled by message ID and only a larger per-message delta is added. When `create_goal` runs inside an assistant turn, the usage already present in that message is recorded as a zero-point baseline so pre-goal work is excluded.

## Install from this checkout

This project has not been installed into the live OpenCode configuration by the repository setup itself.

```powershell
cd 'C:\Users\ruizz\Documents\Projects VS\slash-goal-for-opencode'
bun install
bun run build
```

For a local source checkout, add the server entrypoint to `opencode.json` and the TUI entrypoint to `tui.json`:

```json
{
  "plugin": [
    "file:///C:/Users/ruizz/Documents/Projects%20VS/slash-goal-for-opencode/dist/server.js"
  ]
}
```

```json
{
  "plugin": [
    "file:///C:/Users/ruizz/Documents/Projects%20VS/slash-goal-for-opencode/src/tui.ts"
  ]
}
```

After a future npm publication, the intended install command is:

```powershell
opencode plugin slash-goal-for-opencode
```

No OpenCode source modification is required. See [COMPATIBILITY.md](COMPATIBILITY.md) before changing the peer range.

## Configuration

```json
{
  "plugin": [
    [
      "slash-goal-for-opencode",
      {
        "auto_continue": true,
        "defer_while_tasks_active": true,
        "min_continue_interval_seconds": 3,
        "max_turn_time": 300,
        "max_prompt_failures": 3,
        "restricted_agents": ["plan"],
        "allow_goal_execution_from_plan": false
      }
    ]
  ]
}
```

Optional safety limits are available but disabled unless configured:

- `max_auto_turns`: moves the goal to `usageLimited` after the configured count.
- `max_goal_duration_seconds`: moves the goal to `usageLimited` after the configured elapsed time.
- `max_no_progress_turns`: pauses after the configured number of low-output continuation turns. It has no default limit.
- `no_progress_token_threshold`: low-output threshold used only when `max_no_progress_turns` is configured.

Operational options:

- `auto_continue` defaults to `true`.
- `defer_while_tasks_active` defaults to `true`.
- `min_continue_interval_seconds` defaults to `3`; `0` is accepted explicitly.
- `max_turn_time` is unset by default; a positive number of seconds enables one bounded rescue during a logical busy episode. The rescue is a reserved continuation, so it uses the same nonce, minimum interval, auto-turn accounting, no-progress evaluation, outcome tracking, and `max_prompt_failures` ceiling as idle continuation. Unresolved watchdog and transport attempts therefore cannot produce a fourth automatic attempt at the default ceiling of three. Idle, retry, error, user steering, deletion, and disposal clear the episode.
- `max_prompt_failures` defaults to `3`; it bounds consecutive transport/no-response automatic attempts before the goal pauses and requires `/goal resume`.
- `register_command` defaults to `true`.
- `command_name` defaults to `goal`.
- `restricted_agents` defaults to `["plan"]`.
- `allow_goal_execution_from_plan` defaults to `false`.

## Persistence

State is JSON keyed by OpenCode session ID. Writes use a same-directory temporary file plus atomic rename, in-process mutation ordering, a cross-process lock with stale-lock recovery, Windows transient-lock retries, and owner-only permissions on POSIX.

- Windows: `%APPDATA%\slash-goal-for-opencode\goals.json`
- Linux/macOS: `$XDG_DATA_HOME/slash-goal-for-opencode/goals.json`, or `~/.local/share/slash-goal-for-opencode/goals.json`
- Override for tests or isolated use: `OPENCODE_GOAL_STATE_PATH`

Legacy upstream `unmet` records decode as `blocked` and are rewritten in the native-aligned form on the next mutation.

## Unavoidable OpenCode gap

Native Codex owns thread lifecycle and can finish a `/goal` control action without starting a normal model turn. OpenCode's stable command/config hook expands a command into a chat message and does not provide a supported way for a plugin to cancel that command turn. This plugin therefore applies the command deterministically first, replaces the expanded command text with the authoritative result/steering, and lets the model produce the visible response. State correctness does not depend on that response, but the extra turn cannot currently be removed without an OpenCode source change.

## Development

```powershell
bun install
bun run lint
bun run typecheck
bun test
bun run build
bun run pack:dry-run
```

Tests always set `OPENCODE_GOAL_STATE_PATH` and do not touch a user's live goal state.

## Provenance and license

This repository is derived from [`prevalentWare/opencode-goal-plugin`](https://github.com/prevalentWare/opencode-goal-plugin) and preserves its Git history and MIT license. See [NOTICE](NOTICE) for attribution and modification scope.
