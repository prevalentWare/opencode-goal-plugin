# Compatibility

## Supported range

`slash-goal-for-opencode` declares this peer range:

```text
@opencode-ai/plugin >=1.17.1 <2
```

No OpenCode source patch is required. The server and TUI are separate v1 plugin entrypoints.

## Verified versions

| OpenCode / plugin API | Verification | Status |
| --- | --- | --- |
| OpenCode `1.17.17` | Installed CLI; dual API typecheck, full test/build/pack gate, isolated server load, and isolated TUI command-palette load. | Supported |
| OpenCode `1.18.3` | Exact CLI/package version on 2026-07-20; dual API typecheck, full test/build/pack gate, isolated server load, and isolated TUI command-palette load. | Supported |
| Future `1.x` | Covered by the peer range, but rerun the full gate when hook signatures change. | Expected |
| `2.x` | Outside the peer range. | Unsupported until reviewed |

## Stable hooks used

- `config` for registering the `/goal` command.
- `command.execute.before` plus `chat.message` for authenticated deterministic command application and agent/model capture. Pasted command-template text alone is not accepted as a control action.
- `experimental.chat.system.transform` for active-goal and Plan-mode steering.
- `experimental.chat.messages.transform` for usage/checkpoint observation.
- `experimental.session.compacting` and `experimental.compaction.autocontinue` for compaction continuity.
- `event` for idle continuation, terminal-error handling, and session lifecycle tracking.
- `tool.execute.before` / `tool.execute.after` plus child-session snapshots for Task/subagent deferral.
- `client.session.promptAsync` for continuation, with the recorded agent and provider/model.

The `experimental.*` hooks are the highest compatibility risk inside OpenCode 1.x. A release should not widen the peer range solely because TypeScript compiles; the behavior tests and an isolated OpenCode smoke test must also pass.

Usage accounting relies on assistant message IDs and OpenCode's `input`, `output`, and `reasoning` token fields. Cache fields and the provider-dependent raw `total` field are intentionally excluded. Repeated observations are idempotent, and `create_goal` takes a best-effort current-message baseline when the SDK exposes `client.session.message`.

## Known platform gap

The OpenCode v1 command hook does not expose a supported cancellation result for the command's chat turn. `/goal` mutations are applied before the turn, and the expanded command is replaced with authoritative state/steering, but OpenCode still runs the visible model response. Removing that extra turn would require an upstream API addition or an OpenCode source patch; this package deliberately does neither.

## Release gate

```powershell
bun install
bun run lint
bun run typecheck
bun test
bun run build
bun run pack:dry-run
```

For end-to-end testing, set `OPENCODE_GOAL_STATE_PATH` to a temporary file and use an isolated OpenCode config directory. Never point a smoke test at a user's live goal-state file.
