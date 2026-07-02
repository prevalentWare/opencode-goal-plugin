import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import plugin from "../src/server"

function requireTool<T>(tool: T | undefined, name: string): T {
  if (!tool) throw new Error(`expected ${name} to be registered`)
  return tool
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 500
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  expect(predicate()).toBe(true)
}

async function waitForContinuation(calls: unknown[]) {
  await waitFor(() => calls.length === 1)
  await new Promise((resolve) => setTimeout(resolve, 10))
}

let dir = ""

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "opencode-goal-plugin-"))
  process.env.OPENCODE_GOAL_STATE_PATH = join(dir, "goals.json")
})

afterEach(async () => {
  delete process.env.OPENCODE_GOAL_STATE_PATH
  await rm(dir, { recursive: true, force: true })
})

test("server plugin exposes Codex-style goal tools", async () => {
  const calls: unknown[] = []
  const hooks = await plugin.server(
    {
      client: {
        session: {
          promptAsync: async (input: unknown) => {
            calls.push(input)
          },
        },
      },
    } as never,
    { auto_continue: false },
  )

  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")

  expect(Object.keys(tools).sort()).toEqual([
    "clear_goal",
    "create_goal",
    "get_goal",
    "get_goal_history",
    "set_goal",
    "update_goal",
    "update_goal_objective",
    "update_goal_status",
  ])

  const context = { sessionID: "ses_1" } as never
  const created = await requireTool(tools.create_goal, "create_goal").execute({ objective: "finish" }, context)
  expect(String(created)).toContain('"status": "active"')
  expect(String(created)).toContain('"tokenBudget": null')

  const read = await requireTool(tools.get_goal, "get_goal").execute({}, context)
  expect(String(read)).toContain('"objective": "finish"')

  const completed = await requireTool(tools.update_goal, "update_goal").execute(
    { status: "complete", evidence: "verified locally" },
    context,
  )
  expect(String(completed)).toContain('"completion_report"')
  expect(String(completed)).toContain('"completionEvidence": "verified locally"')
  expect(calls).toHaveLength(0)
})

test("set goal lets the agent formulate the goal objective", async () => {
  const hooks = await plugin.server(
    {
      client: {
        session: {
          promptAsync: async () => {},
        },
      },
    } as never,
    { auto_continue: false },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")

  const created = await requireTool(tools.set_goal, "set_goal").execute(
    { objective: "audit the repo, identify gaps, implement the smallest safe improvement, and verify it" },
    { sessionID: "ses_1" } as never,
  )

  expect(String(created)).toContain('"status": "active"')
  expect(String(created)).toContain("audit the repo")
})

test("server plugin registers goal as a desktop/web command by default", async () => {
  const hooks = await plugin.server(
    {
      client: {
        session: {
          promptAsync: async () => {},
        },
      },
    } as never,
    { auto_continue: false },
  )
  const config = {} as {
    command?: Record<string, { description?: string; template: string }>
  }

  await hooks.config?.(config as never)

  expect(config.command?.goal?.description).toBe("Set or view the long-running session goal")
  expect(config.command?.goal?.template).toContain('OpenCode goal mode command "/goal" was invoked')
  expect(config.command?.goal?.template).toContain("$ARGUMENTS")
  expect(config.command?.goal?.template).toContain('"pause"')
  expect(config.command?.goal?.template).toContain('"resume"')
  expect(config.command?.goal?.template).toContain("token_budget")
  expect(config.command?.goal?.template).toContain('"history"')
  expect(config.command?.goal?.template).toContain('"edit "')
})

test("system transform merges goal context into the primary system block idempotently", async () => {
  const hooks = await plugin.server(
    {
      client: {
        session: {
          promptAsync: async () => {},
        },
      },
    } as never,
    { auto_continue: false },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")

  await requireTool(tools.create_goal, "create_goal").execute({ objective: "finish" }, { sessionID: "ses_1" } as never)
  const output = { system: ["Base system prompt"] }
  await hooks["experimental.chat.system.transform"]!({ sessionID: "ses_1" } as never, output)
  await hooks["experimental.chat.system.transform"]!({ sessionID: "ses_1" } as never, output)

  expect(output.system).toHaveLength(1)
  expect(output.system[0]).toStartWith("Base system prompt")
  expect(output.system[0]).toContain("OpenCode goal mode")
  expect(output.system[0]?.match(/OpenCode goal mode/g)?.length).toBe(1)
})

test("compaction autocontinue is disabled while a goal is active", async () => {
  const hooks = await plugin.server(
    {
      client: {
        session: {
          promptAsync: async () => {},
        },
      },
    } as never,
    { auto_continue: false },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")

  await requireTool(tools.create_goal, "create_goal").execute({ objective: "finish" }, { sessionID: "ses_1" } as never)
  const output = { enabled: true }
  await hooks["experimental.compaction.autocontinue"]!({ sessionID: "ses_1" } as never, output)

  expect(output.enabled).toBe(false)
})

test("goal objective can be edited and history can be reported", async () => {
  const hooks = await plugin.server(
    {
      client: {
        session: {
          promptAsync: async () => {},
        },
      },
    } as never,
    { auto_continue: false },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")
  const context = { sessionID: "ses_1" } as never

  await requireTool(tools.create_goal, "create_goal").execute({ objective: "finish" }, context)
  const edited = await requireTool(tools.update_goal_objective, "update_goal_objective").execute(
    { objective: "finish safely", status: "paused" },
    context,
  )
  const history = await requireTool(tools.get_goal_history, "get_goal_history").execute({}, context)

  expect(String(edited)).toContain("finish safely")
  expect(String(edited)).toContain('"status": "paused"')
  expect(String(history)).toContain("history_report")
  expect(String(history)).toContain("updated")
})

test("goal status tool pauses and resumes a goal", async () => {
  const hooks = await plugin.server(
    {
      client: {
        session: {
          promptAsync: async () => {},
        },
      },
    } as never,
    { auto_continue: false },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")

  const context = { sessionID: "ses_1" } as never
  await requireTool(tools.create_goal, "create_goal").execute({ objective: "finish" }, context)
  const paused = await requireTool(tools.update_goal_status, "update_goal_status").execute({ status: "paused" }, context)
  expect(String(paused)).toContain('"status": "paused"')
  expect(String(paused)).toContain('"lastStatus": "Goal paused."')

  const resumed = await requireTool(tools.update_goal_status, "update_goal_status").execute({ status: "active" }, context)
  expect(String(resumed)).toContain('"status": "active"')
  expect(String(resumed)).toContain('"lastStatus": "Goal resumed."')
})

test("server plugin does not overwrite an existing goal command", async () => {
  const hooks = await plugin.server(
    {
      client: {
        session: {
          promptAsync: async () => {},
        },
      },
    } as never,
    { auto_continue: false },
  )
  const config = {
    command: {
      goal: {
        description: "custom",
        template: "custom template",
      },
    },
  }

  await hooks.config?.(config as never)

  expect(config.command.goal.description).toBe("custom")
  expect(config.command.goal.template).toBe("custom template")
})

test("server plugin can disable desktop/web command registration", async () => {
  const hooks = await plugin.server(
    {
      client: {
        session: {
          promptAsync: async () => {},
        },
      },
    } as never,
    { auto_continue: false, register_command: false },
  )
  const config = {} as {
    command?: Record<string, { description?: string; template: string }>
  }

  await hooks.config?.(config as never)

  expect(config.command).toBeUndefined()
})

test("update goal can close as unmet with a blocker", async () => {
  const hooks = await plugin.server(
    {
      client: {
        session: {
          promptAsync: async () => {},
        },
      },
    } as never,
    { auto_continue: false },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")

  const context = { sessionID: "ses_1" } as never
  await requireTool(tools.create_goal, "create_goal").execute({ objective: "finish" }, context)
  const unmet = await requireTool(tools.update_goal, "update_goal").execute(
    { status: "unmet", blocker: "missing credentials" },
    context,
  )

  expect(String(unmet)).toContain('"status": "unmet"')
  expect(String(unmet)).toContain('"blocker": "missing credentials"')
  expect(String(unmet)).toContain('"unmet_report"')
})

test("message transform prefers exact step token usage", async () => {
  const hooks = await plugin.server(
    {
      client: {
        session: {
          promptAsync: async () => {},
        },
      },
    } as never,
    { auto_continue: false },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")

  const context = { sessionID: "ses_1" } as never
  await requireTool(tools.create_goal, "create_goal").execute({ objective: "finish" }, context)
  await hooks["experimental.chat.messages.transform"]!(
    {},
    {
      messages: [
        {
          info: { sessionID: "ses_1" },
          parts: [
            {
              type: "step-finish",
              tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 4 } },
            },
          ],
        },
      ],
    } as never,
  )
  const read = await requireTool(tools.get_goal, "get_goal").execute({}, context)

  expect(String(read)).toContain('"tokensUsed": 24')
})

test("message transform records assistant checkpoints", async () => {
  const hooks = await plugin.server(
    {
      client: {
        session: {
          promptAsync: async () => {},
        },
      },
    } as never,
    { auto_continue: false },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")

  const context = { sessionID: "ses_1" } as never
  await requireTool(tools.create_goal, "create_goal").execute({ objective: "finish" }, context)
  await hooks["experimental.chat.messages.transform"]!(
    {},
    {
      messages: [
        {
          info: { id: "msg_1", role: "assistant", sessionID: "ses_1", tokens: { output: 100 } },
          parts: [{ type: "text", text: "Inspected the repo and found the next step." }],
        },
      ],
    } as never,
  )

  const read = await requireTool(tools.get_goal, "get_goal").execute({}, context)
  expect(String(read)).toContain("Inspected the repo and found the next step")
})

test("compaction hook preserves active goal context", async () => {
  const hooks = await plugin.server(
    {
      client: {
        session: {
          promptAsync: async () => {},
        },
      },
    } as never,
    { auto_continue: false },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")

  await requireTool(tools.create_goal, "create_goal").execute({ objective: "finish" }, { sessionID: "ses_1" } as never)
  const output = { context: [] as string[], prompt: undefined }
  await hooks["experimental.session.compacting"]!({ sessionID: "ses_1" }, output)

  expect(output.context).toHaveLength(1)
  expect(output.context[0]).toContain("OpenCode goal mode is tracking this session goal across compaction")
  expect(output.context[0]).toContain("Objective: finish")
})

test("idle event auto-continues active goals when enabled", async () => {
  const calls: unknown[] = []
  const hooks = await plugin.server(
    {
      client: {
        session: {
          promptAsync: async (input: unknown) => {
            calls.push(input)
          },
        },
      },
    } as never,
    { auto_continue: true, max_auto_turns: 1, min_continue_interval_seconds: 0 },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")

  await requireTool(tools.create_goal, "create_goal").execute({ objective: "keep going" }, { sessionID: "ses_1" } as never)
  await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } as never })

  expect(calls).toHaveLength(1)
  expect(JSON.stringify(calls[0])).toContain("Continue working toward the active session goal")
})

test("session status idle event auto-continues active goals", async () => {
  const calls: unknown[] = []
  const hooks = await plugin.server(
    {
      client: {
        session: {
          promptAsync: async (input: unknown) => {
            calls.push(input)
          },
        },
      },
    } as never,
    { auto_continue: true, max_auto_turns: 1, min_continue_interval_seconds: 0 },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")

  await requireTool(tools.create_goal, "create_goal").execute({ objective: "keep going" }, { sessionID: "ses_1" } as never)
  await hooks.event!({ event: { type: "session.status", properties: { sessionID: "ses_1", status: { type: "idle" } } } as never })

  expect(calls).toHaveLength(1)
})

test("running task defers idle auto-continue", async () => {
  const calls: unknown[] = []
  const hooks = await plugin.server(
    {
      client: {
        session: {
          promptAsync: async (input: unknown) => {
            calls.push(input)
          },
        },
      },
    } as never,
    { auto_continue: true, max_auto_turns: 1, min_continue_interval_seconds: 0 },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")

  await requireTool(tools.create_goal, "create_goal").execute({ objective: "keep going" }, { sessionID: "ses_1" } as never)
  await hooks["tool.execute.before"]?.(
    { tool: "Task", sessionID: "ses_1", callID: "call_1" } as never,
    { args: { subagent_type: "fixer", background: true } } as never,
  )
  await hooks["tool.execute.after"]?.(
    { tool: "Task", sessionID: "ses_1", callID: "call_1", args: {} } as never,
    { title: "Task", output: "task_id: task_1\nstate: running", metadata: {} } as never,
  )
  await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } as never })

  expect(calls).toHaveLength(0)
})

test("running task deferral does not record repeated assistant messages as no-progress", async () => {
  const calls: unknown[] = []
  const hooks = await plugin.server(
    {
      client: {
        session: {
          messages: async () => ({
            data: [
              {
                id: "msg_waiting",
                role: "assistant",
                time: { completed: Date.now() },
                info: { id: "msg_waiting", role: "assistant", sessionID: "ses_1" },
                parts: [{ type: "text", text: "Waiting for the background task." }],
              },
            ],
          }),
          promptAsync: async (input: unknown) => {
            calls.push(input)
          },
        },
      },
    } as never,
    { auto_continue: true, max_auto_turns: 3, min_continue_interval_seconds: 0, no_progress_token_threshold: 50 },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")

  await requireTool(tools.create_goal, "create_goal").execute({ objective: "keep going" }, { sessionID: "ses_1" } as never)
  await hooks["tool.execute.after"]?.(
    { tool: "Task", sessionID: "ses_1", callID: "call_1", args: {} } as never,
    { title: "Task", output: "task_id: task_1\nstate: running", metadata: {} } as never,
  )

  await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } as never })
  await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } as never })
  await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } as never })

  const read = await requireTool(tools.get_goal, "get_goal").execute({}, { sessionID: "ses_1" } as never)
  expect(calls).toHaveLength(0)
  expect(String(read)).toContain('"status": "active"')
  expect(String(read)).toContain('"autoTurns": 0')
  expect(String(read)).toContain('"noProgressTurns": 0')
})

test("terminal task waits for orchestrator assistant turn before goal continuation", async () => {
  const calls: unknown[] = []
  const hooks = await plugin.server(
    {
      client: {
        session: {
          promptAsync: async (input: unknown) => {
            calls.push(input)
          },
        },
      },
    } as never,
    { auto_continue: true, max_auto_turns: 1, min_continue_interval_seconds: 0 },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")

  await requireTool(tools.create_goal, "create_goal").execute({ objective: "keep going" }, { sessionID: "ses_1" } as never)
  await hooks["tool.execute.after"]?.(
    { tool: "Task", sessionID: "ses_1", callID: "call_1", args: {} } as never,
    { title: "Task", output: "task_id: task_1\nstate: running", metadata: {} } as never,
  )
  await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "task_1" } } as never })
  await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } as never })
  expect(calls).toHaveLength(0)

  await hooks.event!({
    event: {
      type: "message.updated",
      properties: {
        info: {
          id: "msg_after_task",
          role: "assistant",
          sessionID: "ses_1",
          time: { created: Date.now(), completed: Date.now() + 1 },
        },
      },
    } as never,
  })
  await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } as never })

  await waitForContinuation(calls)
  expect(JSON.stringify(calls[0])).toContain("Continue working toward the active session goal")
})

test("terminal-only task output defers until orchestrator reconciles it", async () => {
  const calls: unknown[] = []
  const hooks = await plugin.server(
    {
      client: {
        session: {
          promptAsync: async (input: unknown) => {
            calls.push(input)
          },
        },
      },
    } as never,
    { auto_continue: true, max_auto_turns: 1, min_continue_interval_seconds: 0 },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")

  await requireTool(tools.create_goal, "create_goal").execute({ objective: "keep going" }, { sessionID: "ses_1" } as never)
  await hooks["tool.execute.before"]?.(
    { tool: "Task", sessionID: "ses_1", callID: "call_1" } as never,
    { args: { subagent_type: "fixer", background: true } } as never,
  )
  await hooks["tool.execute.after"]?.(
    { tool: "Task", sessionID: "ses_1", callID: "call_1", args: {} } as never,
    {
      title: "Task",
      output: "task_id: task_1\nstate: completed\n\n<task_result>\ndone\n</task_result>",
      metadata: {},
    } as never,
  )
  await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } as never })

  expect(calls).toHaveLength(0)

  await hooks.event!({
    event: {
      type: "message.updated",
      properties: {
        info: {
          id: "msg_after_terminal_only_task",
          role: "assistant",
          sessionID: "ses_1",
          time: { created: Date.now(), completed: Date.now() + 1 },
        },
      },
    } as never,
  })
  await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } as never })

  await waitForContinuation(calls)
  expect(JSON.stringify(calls[0])).toContain("Continue working toward the active session goal")
})

test("synthetic terminal task message defers until orchestrator reconciles it", async () => {
  const calls: unknown[] = []
  const hooks = await plugin.server(
    {
      client: {
        session: {
          promptAsync: async (input: unknown) => {
            calls.push(input)
          },
        },
      },
    } as never,
    { auto_continue: true, max_auto_turns: 1, min_continue_interval_seconds: 0 },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")

  await requireTool(tools.create_goal, "create_goal").execute({ objective: "keep going" }, { sessionID: "ses_1" } as never)
  await hooks["tool.execute.after"]?.(
    { tool: "Task", sessionID: "ses_1", callID: "call_1", args: {} } as never,
    { title: "Task", output: '<task id="task_1" state="running"></task>', metadata: {} } as never,
  )
  await hooks["experimental.chat.messages.transform"]!(
    {},
    {
      messages: [
        {
          info: { id: "msg_task_done", role: "user", sessionID: "ses_1", agent: "orchestrator" },
          parts: [{ type: "text", synthetic: true, text: "task_id: task_1\nstate: completed\n\n<task_result>\ndone\n</task_result>" }],
        },
      ],
    } as never,
  )
  await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } as never })

  expect(calls).toHaveLength(0)
})

test("live child session status blocks goal continuation when task launch was missed", async () => {
  const calls: unknown[] = []
  const hooks = await plugin.server(
    {
      client: {
        session: {
          children: async () => ({ data: [{ id: "task_1" }] }),
          status: async () => ({ data: { task_1: { type: "busy" } } }),
          promptAsync: async (input: unknown) => {
            calls.push(input)
          },
        },
      },
    } as never,
    { auto_continue: true, max_auto_turns: 1, min_continue_interval_seconds: 0 },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")

  await requireTool(tools.create_goal, "create_goal").execute({ objective: "keep going" }, { sessionID: "ses_1" } as never)
  await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } as never })

  expect(calls).toHaveLength(0)
})

test("idle live child session uses bounded deferral when task launch was missed", async () => {
  const calls: unknown[] = []
  const hooks = await plugin.server(
    {
      client: {
        session: {
          children: async () => ({ data: [{ id: "task_1" }] }),
          status: async () => ({ data: { task_1: { type: "idle" } } }),
          promptAsync: async (input: unknown) => {
            calls.push(input)
          },
        },
      },
    } as never,
    { auto_continue: true, max_auto_turns: 1, min_continue_interval_seconds: 0 },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")

  await requireTool(tools.create_goal, "create_goal").execute({ objective: "keep going" }, { sessionID: "ses_1" } as never)
  await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } as never })

  expect(calls).toHaveLength(0)
  await waitForContinuation(calls)
  expect(JSON.stringify(calls[0])).toContain("Continue working toward the active session goal")
})

test("idle live child bounded retry does not inject while parent session is busy", async () => {
  const calls: unknown[] = []
  const hooks = await plugin.server(
    {
      client: {
        session: {
          children: async () => ({ data: [{ id: "task_1" }] }),
          status: async () => ({ data: { task_1: { type: "idle" } } }),
          promptAsync: async (input: unknown) => {
            calls.push(input)
          },
        },
      },
    } as never,
    { auto_continue: true, max_auto_turns: 1, min_continue_interval_seconds: 0 },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")

  await requireTool(tools.create_goal, "create_goal").execute({ objective: "keep going" }, { sessionID: "ses_1" } as never)
  await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } as never })
  await hooks.event!({
    event: { type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } } as never,
  })
  await new Promise((resolve) => setTimeout(resolve, 300))

  expect(calls).toHaveLength(0)
  await hooks.event!({
    event: { type: "session.status", properties: { sessionID: "ses_1", status: { type: "idle" } } } as never,
  })

  await waitForContinuation(calls)
  expect(JSON.stringify(calls[0])).toContain("Continue working toward the active session goal")
})

test("task deferral can be disabled with config", async () => {
  const calls: unknown[] = []
  const hooks = await plugin.server(
    {
      client: {
        session: {
          promptAsync: async (input: unknown) => {
            calls.push(input)
          },
        },
      },
    } as never,
    { auto_continue: true, defer_while_tasks_active: false, max_auto_turns: 1, min_continue_interval_seconds: 0 },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")

  await requireTool(tools.create_goal, "create_goal").execute({ objective: "keep going" }, { sessionID: "ses_1" } as never)
  await hooks["tool.execute.after"]?.(
    { tool: "Task", sessionID: "ses_1", callID: "call_1", args: {} } as never,
    { title: "Task", output: "task_id: task_1\nstate: running", metadata: {} } as never,
  )
  await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } as never })

  expect(calls).toHaveLength(1)
})

test("auto-continue failures pause after configured retry limit", async () => {
  const logs: unknown[] = []
  const hooks = await plugin.server(
    {
      client: {
        app: {
          log: async (input: unknown) => logs.push(input),
        },
        session: {
          promptAsync: async () => {
            throw new Error("network down")
          },
        },
      },
    } as never,
    { auto_continue: true, max_auto_turns: 2, min_continue_interval_seconds: 0, max_prompt_failures: 1 },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")

  await requireTool(tools.create_goal, "create_goal").execute({ objective: "keep going" }, { sessionID: "ses_1" } as never)
  await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } as never })
  const read = await requireTool(tools.get_goal, "get_goal").execute({}, { sessionID: "ses_1" } as never)

  expect(String(read)).toContain('"status": "paused"')
  expect(String(read)).toContain("Auto-continue prompt failed repeatedly")
  expect(logs).toHaveLength(1)
})

test("set_goal from the plan agent records a paused goal instead of an active one", async () => {
  const calls: unknown[] = []
  const hooks = await plugin.server(
    {
      client: {
        session: {
          promptAsync: async (input: unknown) => {
            calls.push(input)
          },
        },
      },
    } as never,
    { auto_continue: true, max_auto_turns: 5, min_continue_interval_seconds: 0 },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")

  const created = await requireTool(tools.set_goal, "set_goal").execute(
    { objective: "create opencode-goal-plan-bypass.txt" },
    { sessionID: "ses_1", agent: "plan" } as never,
  )

  expect(String(created)).toContain('"status": "paused"')
  expect(String(created)).toContain('"stopReason": "plan mode"')
  expect(String(created)).toContain('"plan_mode_notice"')
  expect(String(created)).toContain("Build mode")

  await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } as never })
  expect(calls).toHaveLength(0)
})

test("create_goal from the plan agent records a paused goal", async () => {
  const hooks = await plugin.server(
    {
      client: {
        session: {
          promptAsync: async () => {},
        },
      },
    } as never,
    { auto_continue: false },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")

  const created = await requireTool(tools.create_goal, "create_goal").execute(
    { objective: "implement the feature" },
    { sessionID: "ses_1", agent: "plan" } as never,
  )

  expect(String(created)).toContain('"status": "paused"')
  expect(String(created)).toContain('"plan_mode_notice"')
})

test("plan-created goal cannot resume from plan but resumes from build", async () => {
  const hooks = await plugin.server(
    {
      client: {
        session: {
          promptAsync: async () => {},
        },
      },
    } as never,
    { auto_continue: false },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")

  await requireTool(tools.set_goal, "set_goal").execute(
    { objective: "implement the feature" },
    { sessionID: "ses_1", agent: "plan" } as never,
  )

  await expect(
    requireTool(tools.update_goal_status, "update_goal_status").execute(
      { status: "active" },
      { sessionID: "ses_1", agent: "plan" } as never,
    ),
  ).rejects.toThrow("Plan mode")

  const resumed = await requireTool(tools.update_goal_status, "update_goal_status").execute(
    { status: "active" },
    { sessionID: "ses_1", agent: "build" } as never,
  )
  expect(String(resumed)).toContain('"status": "active"')
})

test("update_goal_objective cannot activate a goal from the plan agent", async () => {
  const hooks = await plugin.server(
    {
      client: {
        session: {
          promptAsync: async () => {},
        },
      },
    } as never,
    { auto_continue: false },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")

  await requireTool(tools.set_goal, "set_goal").execute(
    { objective: "implement the feature" },
    { sessionID: "ses_1", agent: "plan" } as never,
  )
  const edited = await requireTool(tools.update_goal_objective, "update_goal_objective").execute(
    { objective: "implement the feature safely", status: "active" },
    { sessionID: "ses_1", agent: "plan" } as never,
  )

  expect(String(edited)).toContain('"status": "paused"')
  expect(String(edited)).toContain('"plan_mode_notice"')
  expect(String(edited)).toContain('"stopReason": "plan mode"')
  expect(String(edited)).toContain("Switch to Build mode")
})

test("idle continuation is blocked when the latest assistant turn ran under plan", async () => {
  const calls: unknown[] = []
  const hooks = await plugin.server(
    {
      client: {
        session: {
          promptAsync: async (input: unknown) => {
            calls.push(input)
          },
          messages: async () => ({
            data: [
              {
                info: { id: "msg_plan", role: "assistant", sessionID: "ses_1", mode: "plan" },
                parts: [{ type: "text", text: "Planning analysis only." }],
              },
            ],
          }),
        },
      },
    } as never,
    { auto_continue: true, max_auto_turns: 5, min_continue_interval_seconds: 0 },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")

  await requireTool(tools.create_goal, "create_goal").execute(
    { objective: "keep going" },
    { sessionID: "ses_1", agent: "build" } as never,
  )
  await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } as never })

  expect(calls).toHaveLength(0)
  const read = await requireTool(tools.get_goal, "get_goal").execute({}, { sessionID: "ses_1" } as never)
  expect(String(read)).toContain('"status": "paused"')
  expect(String(read)).toContain('"stopReason": "plan mode"')
})

test("build resume of a plan-created goal restores auto-continue pinned to build", async () => {
  const calls: { body?: { agent?: string } }[] = []
  const hooks = await plugin.server(
    {
      client: {
        session: {
          promptAsync: async (input: unknown) => {
            calls.push(input as { body?: { agent?: string } })
          },
        },
      },
    } as never,
    { auto_continue: true, max_auto_turns: 5, min_continue_interval_seconds: 0 },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")

  await requireTool(tools.set_goal, "set_goal").execute(
    { objective: "implement the feature" },
    { sessionID: "ses_1", agent: "plan" } as never,
  )
  const resumed = await requireTool(tools.update_goal_status, "update_goal_status").execute(
    { status: "active" },
    { sessionID: "ses_1", agent: "build" } as never,
  )
  expect(String(resumed)).toContain('"status": "active"')
  expect(String(resumed)).toContain('"lastPromptAgent": "build"')

  await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } as never })

  expect(calls).toHaveLength(1)
  expect(calls[0]?.body?.agent).toBe("build")
})

test("idle continuation is suppressed and pauses the goal after a plan-mode prompt", async () => {
  const calls: unknown[] = []
  const hooks = await plugin.server(
    {
      client: {
        session: {
          promptAsync: async (input: unknown) => {
            calls.push(input)
          },
        },
      },
    } as never,
    { auto_continue: true, max_auto_turns: 5, min_continue_interval_seconds: 0 },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")

  await requireTool(tools.create_goal, "create_goal").execute(
    { objective: "keep going" },
    { sessionID: "ses_1", agent: "build" } as never,
  )
  await hooks["chat.message"]!(
    { sessionID: "ses_1", agent: "plan" } as never,
    { message: { sessionID: "ses_1", agent: "plan" }, parts: [] } as never,
  )
  await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } as never })

  expect(calls).toHaveLength(0)
  const read = await requireTool(tools.get_goal, "get_goal").execute({}, { sessionID: "ses_1" } as never)
  expect(String(read)).toContain('"status": "paused"')
  expect(String(read)).toContain('"stopReason": "plan mode"')
})

test("auto-continue pins the continuation prompt to the recorded agent", async () => {
  const calls: { body?: { agent?: string } }[] = []
  const hooks = await plugin.server(
    {
      client: {
        session: {
          promptAsync: async (input: unknown) => {
            calls.push(input as { body?: { agent?: string } })
          },
        },
      },
    } as never,
    { auto_continue: true, max_auto_turns: 5, min_continue_interval_seconds: 0 },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")

  await requireTool(tools.create_goal, "create_goal").execute(
    { objective: "keep going" },
    { sessionID: "ses_1", agent: "build" } as never,
  )
  await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } as never })

  expect(calls).toHaveLength(1)
  expect(calls[0]?.body?.agent).toBe("build")
})

test("system reminder becomes planning-only after a plan-mode prompt", async () => {
  const hooks = await plugin.server(
    {
      client: {
        session: {
          promptAsync: async () => {},
        },
      },
    } as never,
    { auto_continue: false },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")

  await requireTool(tools.create_goal, "create_goal").execute(
    { objective: "keep going" },
    { sessionID: "ses_1", agent: "build" } as never,
  )
  await hooks["chat.message"]!(
    { sessionID: "ses_1", agent: "plan" } as never,
    { message: { sessionID: "ses_1", agent: "plan" }, parts: [] } as never,
  )
  const output = { system: ["Base system prompt"] }
  await hooks["experimental.chat.system.transform"]!({ sessionID: "ses_1" } as never, output)

  expect(output.system[0]).toContain("Plan mode")
  expect(output.system[0]).toContain("Do not perform implementation work")
  expect(output.system[0]).not.toContain("Continue working toward the active session goal")
})

test("allow_goal_execution_from_plan restores active goal creation from plan", async () => {
  const hooks = await plugin.server(
    {
      client: {
        session: {
          promptAsync: async () => {},
        },
      },
    } as never,
    { auto_continue: false, allow_goal_execution_from_plan: true },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")

  const created = await requireTool(tools.set_goal, "set_goal").execute(
    { objective: "implement the feature" },
    { sessionID: "ses_1", agent: "plan" } as never,
  )

  expect(String(created)).toContain('"status": "active"')
  expect(String(created)).not.toContain("plan_mode_notice")
})

test("restricted_agents option extends plan-mode protection to custom agents", async () => {
  const hooks = await plugin.server(
    {
      client: {
        session: {
          promptAsync: async () => {},
        },
      },
    } as never,
    { auto_continue: false, restricted_agents: ["plan", "reviewer"] },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")

  const created = await requireTool(tools.create_goal, "create_goal").execute(
    { objective: "implement the feature" },
    { sessionID: "ses_1", agent: "Reviewer" } as never,
  )

  expect(String(created)).toContain('"status": "paused"')
  expect(String(created)).toContain('"plan_mode_notice"')
})

test("idle handler skips overlapping continuations for the same session", async () => {
  let release: (() => void) | undefined
  const calls: unknown[] = []
  const hooks = await plugin.server(
    {
      client: {
        session: {
          promptAsync: async (input: unknown) => {
            calls.push(input)
            await new Promise<void>((resolve) => {
              release = resolve
            })
          },
        },
      },
    } as never,
    { auto_continue: true, max_auto_turns: 5, min_continue_interval_seconds: 0 },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")

  await requireTool(tools.create_goal, "create_goal").execute({ objective: "keep going" }, { sessionID: "ses_1" } as never)
  const first = hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } as never })
  while (!release) await new Promise((resolve) => setTimeout(resolve, 1))
  await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } as never })
  release?.()
  await first

  expect(calls).toHaveLength(1)
})
