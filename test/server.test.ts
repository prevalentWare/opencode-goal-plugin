import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import plugin from "../src/server"

function requireTool<T>(tool: T | undefined, name: string): T {
  if (!tool) throw new Error(`expected ${name} to be registered`)
  return tool
}

async function invokeGoalCommand(
  hooks: Awaited<ReturnType<typeof plugin.server>>,
  args: string,
  input: { sessionID?: string; agent?: string; model?: { providerID: string; modelID: string } } = {},
) {
  const config = {} as { command?: Record<string, { template: string }> }
  await hooks.config?.(config as never)
  const sessionID = input.sessionID ?? "ses_1"
  const agent = input.agent ?? "build"
  const output = {
    message: { sessionID, agent },
    parts: [{ type: "text", text: config.command!.goal!.template.replace("$ARGUMENTS", args) }],
  }
  await hooks["command.execute.before"]?.(
    { command: "goal", sessionID, arguments: args } as never,
    { parts: output.parts } as never,
  )
  await hooks["chat.message"]!(
    { sessionID, agent, model: input.model ?? { providerID: "openai", modelID: "gpt-test" } } as never,
    output as never,
  )
  return output.parts[0]!.text
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
  dir = await mkdtemp(join(tmpdir(), "slash-goal-for-opencode-"))
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

  expect(Object.keys(tools).sort()).toEqual(["create_goal", "get_goal", "update_goal"])
  expect(Object.keys(requireTool(tools.create_goal, "create_goal").args).sort()).toEqual(["objective", "token_budget"])
  expect(Object.keys(requireTool(tools.update_goal, "update_goal").args)).toEqual(["status"])

  const context = { sessionID: "ses_1" } as never
  const created = await requireTool(tools.create_goal, "create_goal").execute({ objective: "finish", token_budget: 100 }, context)
  expect(String(created)).toContain('"status": "active"')
  expect(String(created)).toContain('"tokenBudget": 100')

  const read = await requireTool(tools.get_goal, "get_goal").execute({}, context)
  expect(String(read)).toContain('"objective": "finish"')

  const completed = await requireTool(tools.update_goal, "update_goal").execute(
    { status: "complete" },
    context,
  )
  expect(String(completed)).toContain('"completionBudgetReport"')
  expect(String(completed)).toContain('"completionEvidence": null')
  expect(calls).toHaveLength(0)
})

test("create_goal is the only model-facing creation tool", async () => {
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
  expect(config.command?.goal?.template).toContain('<slash-goal-for-opencode-command name="goal">')
  expect(config.command?.goal?.template).toContain("$ARGUMENTS")
  expect(config.command?.goal?.template).toContain("handled deterministically")
})

test("/goal create, show, and clear mutate state deterministically", async () => {
  const hooks = await plugin.server(
    { client: { session: { promptAsync: async () => {} } } } as never,
    { auto_continue: false },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")

  const created = await invokeGoalCommand(hooks, "ship the compatibility layer")
  expect(created).toContain("created the goal")
  const shown = await invokeGoalCommand(hooks, "")
  expect(shown).toContain("Objective: ship the compatibility layer")
  expect(shown).toContain("No mutation was performed")
  const cleared = await invokeGoalCommand(hooks, "clear")
  expect(cleared).toContain("cleared the current goal")

  const read = await requireTool(tools.get_goal, "get_goal").execute({}, { sessionID: "ses_1" } as never)
  expect(String(read)).toContain('"goal": null')
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

test("goal objective is edited deterministically through /goal edit", async () => {
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
  const edited = await invokeGoalCommand(hooks, "edit finish safely")
  const read = await requireTool(tools.get_goal, "get_goal").execute({}, context)

  expect(edited).toContain("updated and resumed")
  expect(String(read)).toContain("finish safely")
  expect(String(read)).toContain('"type": "updated"')
})

test("pause and resume are deterministic user commands, not model tools", async () => {
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
  const paused = await invokeGoalCommand(hooks, "pause")
  expect(paused).toContain("paused the goal")
  expect(String(await requireTool(tools.get_goal, "get_goal").execute({}, context))).toContain('"status": "paused"')

  const resumed = await invokeGoalCommand(hooks, "resume")
  expect(resumed).toContain("resumed the goal")
  expect(String(await requireTool(tools.get_goal, "get_goal").execute({}, context))).toContain('"status": "active"')
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

test("update_goal enforces the three-turn blocked threshold", async () => {
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
  await expect(requireTool(tools.update_goal, "update_goal").execute({ status: "blocked" }, context)).rejects.toThrow("(1/3)")
  for (let turn = 0; turn < 2; turn += 1) {
    await hooks["chat.message"]!(
      { sessionID: "ses_1", agent: "build" } as never,
      { message: { sessionID: "ses_1", agent: "build" }, parts: [{ type: "text", text: `same blocker ${turn}` }] } as never,
    )
  }
  const blocked = await requireTool(tools.update_goal, "update_goal").execute({ status: "blocked" }, context)

  expect(String(blocked)).toContain('"status": "blocked"')
  expect(String(blocked)).toContain('"blockedAuditTurns": 3')
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
          info: { id: "msg_usage", role: "assistant", sessionID: "ses_1" },
          parts: [
            {
              type: "step-finish",
              tokens: { input: 10, output: 5, reasoning: 2, total: 999, cache: { read: 3, write: 4 } },
            },
          ],
        },
      ],
    } as never,
  )
  const read = await requireTool(tools.get_goal, "get_goal").execute({}, context)

  expect(String(read)).toContain('"tokensUsed": 17')
})

test("message transform replaces text estimates when exact usage arrives later", async () => {
  const hooks = await plugin.server(
    { client: { session: { promptAsync: async () => {} } } } as never,
    { auto_continue: false },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")
  const context = { sessionID: "ses_1" } as never
  await requireTool(tools.create_goal, "create_goal").execute({ objective: "finish" }, context)
  const observe = (messages: unknown[]) => hooks["experimental.chat.messages.transform"]!({}, { messages } as never)

  await observe([
    {
      info: { id: "msg_down", role: "assistant", sessionID: "ses_1" },
      parts: [{ type: "text", text: "x".repeat(80) }],
    },
  ])
  expect(String(await requireTool(tools.get_goal, "get_goal").execute({}, context))).toContain('"tokensUsed": 20')

  await observe([
    {
      info: { id: "msg_down", role: "assistant", sessionID: "ses_1" },
      parts: [{ type: "step-finish", tokens: { input: 2, output: 2, reasoning: 1 } }],
    },
  ])
  expect(String(await requireTool(tools.get_goal, "get_goal").execute({}, context))).toContain('"tokensUsed": 5')

  await observe([
    {
      info: { id: "msg_up", role: "assistant", sessionID: "ses_1" },
      parts: [{ type: "text", text: "xxxx" }],
    },
  ])
  await observe([
    {
      info: { id: "msg_up", role: "assistant", sessionID: "ses_1" },
      parts: [{ type: "step-finish", tokens: { input: 5, output: 4, reasoning: 1 } }],
    },
  ])
  expect(String(await requireTool(tools.get_goal, "get_goal").execute({}, context))).toContain('"tokensUsed": 15')
})

test("message transforms account repeated and growing assistant messages idempotently across compaction", async () => {
  const hooks = await plugin.server(
    { client: { session: { promptAsync: async () => {} } } } as never,
    { auto_continue: false },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")
  const context = { sessionID: "ses_1" } as never
  await requireTool(tools.create_goal, "create_goal").execute({ objective: "finish" }, context)

  const observe = async (messages: unknown[]) =>
    hooks["experimental.chat.messages.transform"]!(
      {},
      { messages } as never,
    )
  const first = {
    info: { id: "msg_streaming", role: "assistant", sessionID: "ses_1" },
    parts: [{ type: "step-finish", tokens: { input: 10, output: 5, reasoning: 2 } }],
  }
  await observe([first])
  await observe([first])
  expect(String(await requireTool(tools.get_goal, "get_goal").execute({}, context))).toContain('"tokensUsed": 17')

  await observe([
    {
      ...first,
      parts: [{ type: "step-finish", tokens: { input: 12, output: 7, reasoning: 3 } }],
    },
  ])
  await observe([
    first,
    {
      info: { id: "msg_multi_step", role: "assistant", sessionID: "ses_1" },
      parts: [
        { type: "step-finish", tokens: { input: 4, output: 2, reasoning: 1 } },
        { type: "step-finish", tokens: { input: 3, output: 1, reasoning: 1 } },
      ],
    },
  ])

  const compaction = { context: [] as string[], prompt: undefined }
  await hooks["experimental.session.compacting"]!({ sessionID: "ses_1" }, compaction)
  await observe([
    {
      info: { id: "msg_multi_step", role: "assistant", sessionID: "ses_1" },
      parts: [
        { type: "step-finish", tokens: { input: 4, output: 2, reasoning: 1 } },
        { type: "step-finish", tokens: { input: 3, output: 1, reasoning: 1 } },
      ],
    },
  ])

  const read = await requireTool(tools.get_goal, "get_goal").execute({}, context)
  expect(String(read)).toContain('"tokensUsed": 34')
  expect(compaction.context).toHaveLength(1)
})

test("create_goal excludes pre-goal and current-message baseline usage", async () => {
  const current = {
    info: { id: "msg_create", role: "assistant", sessionID: "ses_1" },
    parts: [{ type: "step-finish", tokens: { input: 100, output: 50, reasoning: 10 } }],
  }
  const hooks = await plugin.server(
    {
      client: {
        session: {
          message: async () => ({ data: current }),
          promptAsync: async () => {},
        },
      },
    } as never,
    { auto_continue: false },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")
  const context = { sessionID: "ses_1", messageID: "msg_create" } as never
  await requireTool(tools.create_goal, "create_goal").execute({ objective: "finish" }, context)

  await hooks["experimental.chat.messages.transform"]!(
    {},
    {
      messages: [
        {
          info: { id: "msg_before_goal", role: "assistant", sessionID: "ses_1" },
          parts: [{ type: "step-finish", tokens: { input: 200, output: 100, reasoning: 20 } }],
        },
        current,
      ],
    } as never,
  )
  expect(String(await requireTool(tools.get_goal, "get_goal").execute({}, context))).toContain('"tokensUsed": 0')

  await hooks["experimental.chat.messages.transform"]!(
    {},
    {
      messages: [
        current,
        {
          info: { id: "msg_after_goal", role: "assistant", sessionID: "ses_1" },
          parts: [{ type: "step-finish", tokens: { input: 10, output: 5, reasoning: 2 } }],
        },
      ],
    } as never,
  )
  expect(String(await requireTool(tools.get_goal, "get_goal").execute({}, context))).toContain('"tokensUsed": 17')
})

test("raw total and cache-only token fields do not consume a native goal budget", async () => {
  const hooks = await plugin.server(
    { client: { session: { promptAsync: async () => {} } } } as never,
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
          info: { id: "msg_provider_total", role: "assistant", sessionID: "ses_1" },
          parts: [{ type: "step-finish", tokens: { total: 999, cache: { read: 700, write: 299 } } }],
        },
      ],
    } as never,
  )

  expect(String(await requireTool(tools.get_goal, "get_goal").execute({}, context))).toContain('"tokensUsed": 0')
})

test("explicit zero step usage does not fall back to text estimation", async () => {
  const hooks = await plugin.server(
    { client: { session: { promptAsync: async () => {} } } } as never,
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
          info: { id: "msg_zero", role: "assistant", sessionID: "ses_1" },
          parts: [
            { type: "text", text: "This text must not be estimated when exact zero usage is present." },
            { type: "step-finish", tokens: { input: 0, output: 0, reasoning: 0 } },
          ],
        },
      ],
    } as never,
  )

  expect(String(await requireTool(tools.get_goal, "get_goal").execute({}, context))).toContain('"tokensUsed": 0')
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

test("a delayed duplicate idle notification cannot emit another automatic attempt", async () => {
  const calls: unknown[] = []
  const hooks = await plugin.server(
    {
      client: {
        session: {
          promptAsync: async (input: unknown) => calls.push(input),
        },
      },
    } as never,
    { auto_continue: true, min_continue_interval_seconds: 0, max_prompt_failures: 3 },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")
  const sessionID = "ses_delayed_duplicate_idle"
  await requireTool(tools.create_goal, "create_goal").execute({ objective: "keep going" }, { sessionID } as never)

  await hooks.event!({
    event: { type: "session.status", properties: { sessionID, status: { type: "idle" } } } as never,
  })
  await new Promise((resolve) => setTimeout(resolve, 40))
  await hooks.event!({ event: { type: "session.idle", properties: { sessionID } } as never })

  expect(calls).toHaveLength(1)
})

test("turn watchdog sends one nonce-tracked rescue per busy episode without recursive rearming", async () => {
  const calls: { body?: { agent?: string; parts?: { text?: string }[] } }[] = []
  let acceptedText = ""
  let acceptedCount = 0
  let latest = {
    info: { id: "msg_before_watchdog", role: "assistant", sessionID: "ses_1" },
    parts: [{ type: "text", text: "Progress before the busy episode." }],
  }
  const hooks = await plugin.server(
    {
      client: {
        session: {
          messages: async () => ({ data: [latest] }),
          promptAsync: async (input: unknown) => {
            const request = input as { body?: { agent?: string; parts?: { type?: string; text?: string }[] } }
            calls.push(request)
            const parts = structuredClone(request.body?.parts ?? [])
            await hooks["chat.message"]!(
              { sessionID: "ses_1", agent: request.body?.agent ?? "build" } as never,
              { message: { sessionID: "ses_1", agent: request.body?.agent ?? "build" }, parts } as never,
            )
            acceptedText = parts[0]?.text ?? ""
            await hooks.event!({
              event: { type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } } as never,
            })
            acceptedCount += 1
          },
        },
      },
    } as never,
    {
      auto_continue: false,
      min_continue_interval_seconds: 0,
      max_turn_time: 0.02,
      max_auto_turns: 5,
      max_prompt_failures: 3,
    },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")

  const context = { sessionID: "ses_1", agent: "build" } as never
  await requireTool(tools.create_goal, "create_goal").execute({ objective: "keep going" }, context)
  await hooks.event!({
    event: { type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } } as never,
  })

  await waitForContinuation(calls)
  await new Promise((resolve) => setTimeout(resolve, 30))

  expect(calls).toHaveLength(1)
  expect(calls[0]?.body?.agent).toBe("build")
  expect(calls[0]?.body?.parts?.[0]?.text).toContain("Continue working toward the active session goal")
  expect(acceptedText).not.toContain("slash-goal-for-opencode-continuation")
  const read = await requireTool(tools.get_goal, "get_goal").execute({}, context)
  expect(String(read)).toContain('"status": "active"')
  expect(String(read)).toContain('"autoTurns": 1')
  expect(String(read)).toContain('"continuationFailures": 0')
  expect(String(read)).toContain('"awaitingContinuationProgress": true')

  await hooks.event!({
    event: { type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } } as never,
  })
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(calls).toHaveLength(1)

  await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } as never })
  latest = {
    info: { id: "msg_after_watchdog", role: "assistant", sessionID: "ses_1" },
    parts: [{ type: "text", text: "The rescued turn made substantive progress." }],
  }
  await hooks.event!({
    event: { type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } } as never,
  })
  await waitFor(() => calls.length === 2)
  await waitFor(() => acceptedCount === 2)
  await hooks.dispose?.()
})

test("turn watchdog resets when another busy turn starts", async () => {
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
    { auto_continue: false, max_turn_time: 0.08 },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")

  await requireTool(tools.create_goal, "create_goal").execute({ objective: "keep going" }, { sessionID: "ses_1" } as never)
  await hooks.event!({
    event: { type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } } as never,
  })
  await new Promise((resolve) => setTimeout(resolve, 50))
  await hooks.event!({
    event: { type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } } as never,
  })
  await new Promise((resolve) => setTimeout(resolve, 50))

  expect(calls).toHaveLength(0)
  await waitForContinuation(calls)
})

test("turn watchdog cancels on idle, retry, deletion, and dispose", async () => {
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
    { auto_continue: false, max_turn_time: 0.02 },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")

  for (const sessionID of ["ses_idle", "ses_retry", "ses_error", "ses_user", "ses_deleted"]) {
    await requireTool(tools.create_goal, "create_goal").execute({ objective: "keep going" }, { sessionID } as never)
    await hooks.event!({
      event: { type: "session.status", properties: { sessionID, status: { type: "busy" } } } as never,
    })
  }
  await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_idle" } } as never })
  await hooks.event!({
    event: { type: "session.status", properties: { sessionID: "ses_retry", status: { type: "retry" } } } as never,
  })
  await hooks.event!({
    event: {
      type: "session.error",
      properties: { sessionID: "ses_error", error: { name: "AbortError", message: "User interrupted the turn." } },
    } as never,
  })
  await hooks["chat.message"]!(
    { sessionID: "ses_user", agent: "build" } as never,
    {
      message: { sessionID: "ses_user", agent: "build" },
      parts: [{ type: "text", text: "Replace the busy turn with explicit user steering." }],
    } as never,
  )
  await hooks.event!({ event: { type: "session.deleted", properties: { info: { id: "ses_deleted" } } } as never })
  await new Promise((resolve) => setTimeout(resolve, 50))

  expect(calls).toHaveLength(0)

  await requireTool(tools.create_goal, "create_goal").execute(
    { objective: "keep going" },
    { sessionID: "ses_disposed" } as never,
  )
  await hooks.event!({
    event: { type: "session.status", properties: { sessionID: "ses_disposed", status: { type: "busy" } } } as never,
  })
  await hooks.dispose?.()
  await new Promise((resolve) => setTimeout(resolve, 50))

  expect(calls).toHaveLength(0)
})

test("turn watchdog does not inject while tasks are active, the goal is paused, or the turn is restricted", async () => {
  const calls: unknown[] = []
  const hooks = await plugin.server(
    {
      client: {
        session: {
          messages: async (input: { path: { id: string } }) => ({
            data:
              input.path.id === "ses_latest_plan"
                ? [
                    {
                      info: { id: "msg_plan", role: "assistant", sessionID: "ses_latest_plan", mode: "plan" },
                      parts: [],
                    },
                  ]
                : [],
          }),
          promptAsync: async (input: unknown) => {
            calls.push(input)
          },
        },
      },
    } as never,
    { auto_continue: false, max_turn_time: 0.02 },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")

  await requireTool(tools.create_goal, "create_goal").execute(
    { objective: "task goal" },
    { sessionID: "ses_task", agent: "build" } as never,
  )
  await hooks["tool.execute.after"]?.(
    { tool: "Task", sessionID: "ses_task", callID: "call_1", args: {} } as never,
    { title: "Task", output: "task_id: task_1\nstate: running", metadata: {} } as never,
  )
  await requireTool(tools.create_goal, "create_goal").execute(
    { objective: "restricted goal" },
    { sessionID: "ses_plan", agent: "build" } as never,
  )
  await hooks["chat.message"]!(
    { sessionID: "ses_plan", agent: "plan" } as never,
    { message: { sessionID: "ses_plan", agent: "plan" }, parts: [] } as never,
  )
  await requireTool(tools.create_goal, "create_goal").execute(
    { objective: "latest restricted turn" },
    { sessionID: "ses_latest_plan", agent: "build" } as never,
  )
  await requireTool(tools.create_goal, "create_goal").execute(
    { objective: "paused goal" },
    { sessionID: "ses_paused", agent: "build" } as never,
  )
  await invokeGoalCommand(hooks, "pause", { sessionID: "ses_paused", agent: "build" })
  for (const sessionID of ["ses_task", "ses_plan", "ses_latest_plan", "ses_paused"]) {
    await hooks.event!({
      event: { type: "session.status", properties: { sessionID, status: { type: "busy" } } } as never,
    })
  }
  await new Promise((resolve) => setTimeout(resolve, 50))

  expect(calls).toHaveLength(0)
})

test("turn watchdog transport failures use the configured continuation failure ceiling", async () => {
  const logs: unknown[] = []
  const hooks = await plugin.server(
    {
      client: {
        app: { log: async (input: unknown) => logs.push(input) },
        session: {
          promptAsync: async () => {
            throw new Error("network down")
          },
        },
      },
    } as never,
    { auto_continue: false, max_turn_time: 0.02, max_prompt_failures: 1 },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")

  const context = { sessionID: "ses_1" } as never
  await requireTool(tools.create_goal, "create_goal").execute({ objective: "keep going" }, context)
  await hooks.event!({
    event: { type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } } as never,
  })
  await waitFor(() => logs.length === 1)

  const read = await requireTool(tools.get_goal, "get_goal").execute({}, context)
  expect(String(read)).toContain('"status": "paused"')
  expect(String(read)).toContain('"autoTurns": 1')
  expect(String(read)).toContain('"continuationFailures": 1')
  expect(JSON.stringify(logs[0])).toContain("Turn watchdog retry failed")
})

test("watchdog and unresolved turn attempts share one three-attempt ceiling with no fourth send", async () => {
  const calls: unknown[] = []
  const sessionID = "ses_watchdog_bounded"
  const latest = {
    info: { id: "msg_watchdog_baseline", role: "assistant", sessionID },
    parts: [{ type: "text", text: "Progress before the provider stopped returning assistant output." }],
  }
  const hooks = await plugin.server(
    {
      client: {
        session: {
          messages: async () => ({ data: [latest] }),
          promptAsync: async (input: unknown) => calls.push(input),
        },
      },
    } as never,
    { auto_continue: true, min_continue_interval_seconds: 0, max_turn_time: 0.02, max_prompt_failures: 3 },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")
  const context = { sessionID, agent: "build" } as never
  await requireTool(tools.create_goal, "create_goal").execute({ objective: "keep working" }, context)

  await hooks.event!({ event: { type: "session.idle", properties: { sessionID } } as never })
  expect(calls).toHaveLength(1)
  await hooks.event!({
    event: { type: "session.status", properties: { sessionID, status: { type: "busy" } } } as never,
  })
  await waitFor(() => calls.length === 2)
  await new Promise((resolve) => setTimeout(resolve, 20))

  await hooks.event!({
    event: { type: "session.status", properties: { sessionID, status: { type: "idle" } } } as never,
  })
  expect(calls).toHaveLength(3)
  await hooks.event!({
    event: { type: "session.status", properties: { sessionID, status: { type: "busy" } } } as never,
  })
  await new Promise((resolve) => setTimeout(resolve, 60))

  const paused = await requireTool(tools.get_goal, "get_goal").execute({}, context)
  expect(calls).toHaveLength(3)
  expect(String(paused)).toContain('"status": "paused"')
  expect(String(paused)).toContain('"continuationFailures": 3')

  const resumed = await invokeGoalCommand(hooks, "resume", { sessionID, agent: "build" })
  expect(resumed).toContain("resumed the goal")
  await hooks.event!({ event: { type: "session.idle", properties: { sessionID } } as never })
  expect(calls).toHaveLength(4)
  expect(String(await requireTool(tools.get_goal, "get_goal").execute({}, context))).toContain(
    '"continuationFailures": 0',
  )
  await hooks.dispose?.()
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

test("low-output tool-call messages do not pause an active goal without continuations", async () => {
  const hooks = await plugin.server(
    {
      client: {
        session: {
          promptAsync: async () => {},
        },
      },
    } as never,
    { auto_continue: false, no_progress_token_threshold: 50, max_no_progress_turns: 2 },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")

  await requireTool(tools.create_goal, "create_goal").execute({ objective: "long running goal" }, { sessionID: "ses_1" } as never)

  for (const [id, tokens] of [
    ["m1", 43],
    ["m2", 48],
    ["m3", 15],
  ] as const) {
    await hooks["experimental.chat.messages.transform"]!(
      {},
      {
        messages: [
          {
            info: { id, role: "assistant", sessionID: "ses_1" },
            parts: [
              { type: "text", text: "Checking PTY status." },
              { type: "step-finish", tokens: { input: 10, output: tokens } },
            ],
          },
        ],
      } as never,
    )
  }

  const read = await requireTool(tools.get_goal, "get_goal").execute({}, { sessionID: "ses_1" } as never)
  expect(String(read)).toContain('"status": "active"')
  expect(String(read)).toContain('"noProgressTurns": 0')
  expect(String(read)).toContain('"autoTurns": 0')
})

test("auto-continue pauses only after a low-progress continuation turn", async () => {
  const calls: unknown[] = []
  let latest = {
    info: { id: "m0", role: "assistant", sessionID: "ses_1" },
    parts: [
      { type: "text", text: "Initial rich progress" },
      { type: "step-finish", tokens: { input: 10, output: 200 } },
    ],
  }
  const hooks = await plugin.server(
    {
      client: {
        session: {
          promptAsync: async (input: unknown) => {
            calls.push(input)
          },
          messages: async () => ({ data: [latest] }),
        },
      },
    } as never,
    {
      auto_continue: true,
      max_auto_turns: 10,
      min_continue_interval_seconds: 0,
      no_progress_token_threshold: 50,
      max_no_progress_turns: 1,
    },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")

  await requireTool(tools.create_goal, "create_goal").execute({ objective: "keep going" }, { sessionID: "ses_1" } as never)

  await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } as never })
  expect(calls).toHaveLength(1)
  const active = await requireTool(tools.get_goal, "get_goal").execute({}, { sessionID: "ses_1" } as never)
  expect(String(active)).toContain('"status": "active"')
  expect(String(active)).toContain('"noProgressTurns": 0')

  latest = {
    info: { id: "m1", role: "assistant", sessionID: "ses_1" },
    parts: [
      { type: "text", text: "Initial rich progress" },
      { type: "step-finish", tokens: { input: 10, output: 10 } },
    ],
  }
  await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } as never })

  expect(calls).toHaveLength(1)
  const read = await requireTool(tools.get_goal, "get_goal").execute({}, { sessionID: "ses_1" } as never)
  expect(String(read)).toContain('"status": "paused"')
  expect(String(read)).toContain('"stopReason": "no progress"')
  expect(String(read)).toContain('"autoTurns": 1')
  expect(String(read)).toContain("low-progress continuation turn")
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

test("tracked running child absent from live children stops blocking after grace period", async () => {
  const calls: unknown[] = []
  let children = [{ id: "task_1" }]
  const hooks = await plugin.server(
    {
      client: {
        session: {
          children: async () => ({ data: children }),
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

  children = []
  await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } as never })

  expect(calls).toHaveLength(0)
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

test("/goal creation from the plan agent records a paused goal instead of an active one", async () => {
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

  const created = await invokeGoalCommand(hooks, "create opencode-goal-plan-bypass.txt", { agent: "plan" })

  expect(String(created)).toContain("Status: paused")
  expect(String(created)).toContain("Stop reason: plan mode")
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
  expect(String(created)).toContain('"planModeNotice"')
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

  await invokeGoalCommand(hooks, "implement the feature", { agent: "plan" })

  const planResume = await invokeGoalCommand(hooks, "resume", { agent: "plan" })
  expect(planResume).toContain("did not resume")

  const resumed = await invokeGoalCommand(hooks, "resume", { agent: "build" })
  expect(resumed).toContain("resumed the goal")
  const read = await requireTool(tools.get_goal, "get_goal").execute({}, { sessionID: "ses_1" } as never)
  expect(String(read)).toContain('"status": "active"')
})

test("/goal edit cannot activate a goal from the plan agent", async () => {
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

  await invokeGoalCommand(hooks, "implement the feature", { agent: "plan" })
  const edited = await invokeGoalCommand(hooks, "edit implement the feature safely", { agent: "plan" })
  const read = await requireTool(tools.get_goal, "get_goal").execute({}, { sessionID: "ses_1" } as never)

  expect(String(edited)).toContain("execution is paused")
  expect(String(read)).toContain('"status": "paused"')
  expect(String(read)).toContain('"stopReason": "plan mode"')
  expect(String(read)).toContain("Switch to Build mode")
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

  await invokeGoalCommand(hooks, "implement the feature", { agent: "plan" })
  const resumed = await invokeGoalCommand(hooks, "resume", { agent: "build" })
  expect(String(resumed)).toContain("resumed the goal")

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

test("auto-continue pins the continuation prompt to the recorded agent and model", async () => {
  const calls: { body?: { agent?: string; model?: { providerID: string; modelID: string } } }[] = []
  const hooks = await plugin.server(
    {
      client: {
        session: {
          promptAsync: async (input: unknown) => {
            calls.push(input as { body?: { agent?: string; model?: { providerID: string; modelID: string } } })
          },
        },
      },
    } as never,
    { auto_continue: true, max_auto_turns: 5, min_continue_interval_seconds: 0 },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")

  await hooks["chat.message"]!(
    { sessionID: "ses_1", agent: "build", model: { providerID: "openai", modelID: "gpt-5.6" } } as never,
    { message: { sessionID: "ses_1", agent: "build" }, parts: [{ type: "text", text: "set a goal" }] } as never,
  )
  await requireTool(tools.create_goal, "create_goal").execute(
    { objective: "keep going" },
    { sessionID: "ses_1", agent: "build" } as never,
  )
  await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } as never })

  expect(calls).toHaveLength(1)
  expect(calls[0]?.body?.agent).toBe("build")
  expect(calls[0]?.body?.model).toEqual({ providerID: "openai", modelID: "gpt-5.6" })
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

  const created = await requireTool(tools.create_goal, "create_goal").execute(
    { objective: "implement the feature" },
    { sessionID: "ses_1", agent: "plan" } as never,
  )

  expect(String(created)).toContain('"status": "active"')
  expect(String(created)).not.toContain("planModeNotice")
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
  expect(String(created)).toContain('"planModeNotice"')
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

test("the plugin continuation chat hook preserves its exact reservation and strips the wire nonce", async () => {
  let acceptedText = ""
  const hooks = await plugin.server(
    {
      client: {
        session: {
          promptAsync: async (input: unknown) => {
            const request = input as { body?: { parts?: { type: string; text: string }[]; agent?: string } }
            const parts = structuredClone(request.body?.parts ?? [])
            await hooks["chat.message"]!(
              { sessionID: "ses_1", agent: request.body?.agent ?? "build" } as never,
              { message: { sessionID: "ses_1", agent: request.body?.agent ?? "build" }, parts } as never,
            )
            acceptedText = parts[0]?.text ?? ""
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
    { sessionID: "ses_1" } as never,
  )

  await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } as never })

  expect(acceptedText).toContain("Continue working toward the active session goal")
  expect(acceptedText).not.toContain("slash-goal-for-opencode-continuation")
  const read = await requireTool(tools.get_goal, "get_goal").execute({}, { sessionID: "ses_1" } as never)
  expect(String(read)).toContain('"autoTurns": 1')
  expect(String(read)).toContain('"awaitingContinuationProgress": true')
})

test("a new user prompt cancels a scheduled task-settle continuation", async () => {
  const calls: unknown[] = []
  const hooks = await plugin.server(
    {
      client: {
        session: {
          children: async () => ({ data: [{ id: "task_1" }] }),
          status: async () => ({ data: { task_1: { type: "idle" } } }),
          promptAsync: async (input: unknown) => calls.push(input),
        },
      },
    } as never,
    { auto_continue: true, max_auto_turns: 5, min_continue_interval_seconds: 0 },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")
  await requireTool(tools.create_goal, "create_goal").execute(
    { objective: "keep going" },
    { sessionID: "ses_1" } as never,
  )

  await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } as never })
  expect(calls).toHaveLength(0)

  await hooks["chat.message"]!(
    { sessionID: "ses_1", agent: "build" } as never,
    {
      message: { sessionID: "ses_1", agent: "build" },
      parts: [{ type: "text", text: "User steering arrived before the deferred continuation." }],
    } as never,
  )
  await new Promise((resolve) => setTimeout(resolve, 300))

  expect(calls).toHaveLength(0)
  expect(String(await requireTool(tools.get_goal, "get_goal").execute({}, { sessionID: "ses_1" } as never))).toContain(
    '"autoTurns": 0',
  )
})

test("a new user prompt cancels an in-flight stale continuation attempt", async () => {
  let releaseMessages: (() => void) | undefined
  let messagesStarted = false
  const calls: unknown[] = []
  const hooks = await plugin.server(
    {
      client: {
        session: {
          messages: async () => {
            messagesStarted = true
            await new Promise<void>((resolve) => {
              releaseMessages = resolve
            })
            return {
              data: [
                {
                  info: { id: "msg_old", role: "assistant", sessionID: "ses_1" },
                  parts: [{ type: "text", text: "Old assistant result." }],
                },
              ],
            }
          },
          promptAsync: async (input: unknown) => calls.push(input),
        },
      },
    } as never,
    { auto_continue: true, max_auto_turns: 5, min_continue_interval_seconds: 0 },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")
  await requireTool(tools.create_goal, "create_goal").execute(
    { objective: "keep going" },
    { sessionID: "ses_1" } as never,
  )

  const idle = hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } as never })
  await waitFor(() => messagesStarted)
  await hooks["chat.message"]!(
    { sessionID: "ses_1", agent: "build" } as never,
    {
      message: { sessionID: "ses_1", agent: "build" },
      parts: [{ type: "text", text: "New user steering supersedes the idle attempt." }],
    } as never,
  )
  releaseMessages?.()
  await idle

  expect(calls).toHaveLength(0)
  expect(String(await requireTool(tools.get_goal, "get_goal").execute({}, { sessionID: "ses_1" } as never))).toContain(
    '"autoTurns": 0',
  )
})

test("user steering during promptAsync prevents the stale send result from arming continuation evaluation", async () => {
  let releasePrompt: (() => void) | undefined
  let promptStarted = false
  const hooks = await plugin.server(
    {
      client: {
        session: {
          promptAsync: async () => {
            promptStarted = true
            await new Promise<void>((resolve) => {
              releasePrompt = resolve
            })
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
    { sessionID: "ses_1" } as never,
  )

  const idle = hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } as never })
  await waitFor(() => promptStarted)
  await hooks["chat.message"]!(
    { sessionID: "ses_1", agent: "build" } as never,
    {
      message: { sessionID: "ses_1", agent: "build" },
      parts: [{ type: "text", text: "User steering arrived while promptAsync was blocked." }],
    } as never,
  )

  const steered = await requireTool(tools.get_goal, "get_goal").execute({}, { sessionID: "ses_1" } as never)
  expect(String(steered)).toContain('"continuationReservation": null')
  expect(String(steered)).toContain('"awaitingContinuationProgress": false')
  expect(String(steered)).toContain('"autoTurns": 0')

  releasePrompt?.()
  await idle
  const final = await requireTool(tools.get_goal, "get_goal").execute({}, { sessionID: "ses_1" } as never)
  expect(String(final)).toContain('"continuationReservation": null')
  expect(String(final)).toContain('"awaitingContinuationProgress": false')
  expect(String(final)).toContain('"autoTurns": 0')
})

test("empty continuation turns pause after three attempts, never send a fourth, and reset on explicit resume", async () => {
  const calls: unknown[] = []
  let latest: { info: { id: string; role: string; sessionID: string }; parts: unknown[] } = {
    info: { id: "msg_before_failures", role: "assistant", sessionID: "ses_transport_bounded" },
    parts: [{ type: "text", text: "Concrete progress before the backend stopped responding." }],
  }
  const hooks = await plugin.server(
    {
      client: {
        session: {
          messages: async () => ({ data: [latest] }),
          promptAsync: async (input: unknown) => calls.push(input),
        },
      },
    } as never,
    { auto_continue: true, min_continue_interval_seconds: 0, max_prompt_failures: 3 },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")
  const sessionID = "ses_transport_bounded"
  const context = { sessionID } as never
  await requireTool(tools.create_goal, "create_goal").execute({ objective: "keep working" }, context)

  await hooks.event!({ event: { type: "session.idle", properties: { sessionID } } as never })
  expect(calls).toHaveLength(1)
  await new Promise((resolve) => setTimeout(resolve, 50))
  await hooks.event!({ event: { type: "session.idle", properties: { sessionID } } as never })
  expect(calls).toHaveLength(1)

  for (let failedAttempt = 1; failedAttempt <= 3; failedAttempt += 1) {
    await hooks.event!({
      event: { type: "session.status", properties: { sessionID, status: { type: "busy" } } } as never,
    })
    latest = {
      info: { id: `msg_empty_${failedAttempt}`, role: "assistant", sessionID },
      parts: [{ type: "text", text: "" }],
    }
    await hooks.event!({
      event: { type: "session.status", properties: { sessionID, status: { type: "idle" } } } as never,
    })
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID } } as never })
  }

  const paused = await requireTool(tools.get_goal, "get_goal").execute({}, context)
  expect(calls).toHaveLength(3)
  expect(String(paused)).toContain('"status": "paused"')
  expect(String(paused)).toContain('"continuationFailures": 3')

  await hooks.event!({ event: { type: "session.idle", properties: { sessionID } } as never })
  expect(calls).toHaveLength(3)

  const resumed = await invokeGoalCommand(hooks, "resume", { sessionID, agent: "build" })
  expect(resumed).toContain("resumed the goal")
  const reset = await requireTool(tools.get_goal, "get_goal").execute({}, context)
  expect(String(reset)).toContain('"status": "active"')
  expect(String(reset)).toContain('"continuationFailures": 0')
  await hooks.event!({ event: { type: "session.idle", properties: { sessionID } } as never })
  expect(calls).toHaveLength(4)
})

test("substantive tool-call assistant progress resets the transport failure streak", async () => {
  const calls: unknown[] = []
  const sessionID = "ses_transport_tool_progress"
  let latest: { info: { id: string; role: string; sessionID: string }; parts: unknown[] } = {
    info: { id: "msg_before_transport_error", role: "assistant", sessionID },
    parts: [{ type: "text", text: "Started the investigation." }],
  }
  const hooks = await plugin.server(
    {
      client: {
        session: {
          messages: async () => ({ data: [latest] }),
          promptAsync: async (input: unknown) => calls.push(input),
        },
      },
    } as never,
    { auto_continue: true, min_continue_interval_seconds: 0, max_prompt_failures: 3 },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")
  const context = { sessionID } as never
  const transportError = {
    event: {
      type: "session.error",
      properties: {
        sessionID,
        error: { name: "ConnectError", code: "ECONNRESET", message: "Unable to connect to the backend." },
      },
    } as never,
  }
  await requireTool(tools.create_goal, "create_goal").execute({ objective: "keep working" }, context)

  await hooks.event!({ event: { type: "session.idle", properties: { sessionID } } as never })
  await hooks.event!(transportError)
  await hooks.event!({ event: { type: "session.idle", properties: { sessionID } } as never })
  expect(calls).toHaveLength(2)

  latest = {
    info: { id: "msg_tool_progress", role: "assistant", sessionID },
    parts: [{ type: "tool", callID: "call_inspect", state: { status: "completed", output: "inspected files" } }],
  }
  await hooks.event!({
    event: { type: "session.status", properties: { sessionID, status: { type: "busy" } } } as never,
  })
  await hooks.event!({
    event: { type: "session.status", properties: { sessionID, status: { type: "idle" } } } as never,
  })
  expect(calls).toHaveLength(3)
  expect(String(await requireTool(tools.get_goal, "get_goal").execute({}, context))).toContain(
    '"continuationFailures": 0',
  )

  await hooks.event!(transportError)
  await hooks.event!({ event: { type: "session.idle", properties: { sessionID } } as never })
  await hooks.event!(transportError)
  const stillActive = await requireTool(tools.get_goal, "get_goal").execute({}, context)
  expect(String(stillActive)).toContain('"status": "active"')
  expect(String(stillActive)).toContain('"continuationFailures": 2')
})

test("failed cancelled aborted and incomplete tool-only shells do not reset transport failures", async () => {
  const calls: { path?: { id?: string } }[] = []
  const latestBySession = new Map<string, { info: { id: string; role: string; sessionID: string }; parts: unknown[] }>()
  const hooks = await plugin.server(
    {
      client: {
        session: {
          messages: async (input: { path: { id: string } }) => ({ data: [latestBySession.get(input.path.id)] }),
          promptAsync: async (input: { path?: { id?: string } }) => calls.push(input),
        },
      },
    } as never,
    { auto_continue: true, min_continue_interval_seconds: 0, max_prompt_failures: 2 },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")

  for (const status of ["failed", "cancelled", "aborted", "incomplete"]) {
    const sessionID = `ses_tool_shell_${status}`
    const context = { sessionID } as never
    latestBySession.set(sessionID, {
      info: { id: `msg_before_${status}`, role: "assistant", sessionID },
      parts: [{ type: "text", text: "Baseline assistant progress." }],
    })
    await requireTool(tools.create_goal, "create_goal").execute({ objective: "keep working" }, context)
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID } } as never })
    await hooks.event!({
      event: {
        type: "session.error",
        properties: {
          sessionID,
          error: { name: "ConnectError", code: "ECONNRESET", message: "Unable to connect to the backend." },
        },
      } as never,
    })
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID } } as never })

    latestBySession.set(sessionID, {
      info: { id: `msg_shell_${status}`, role: "assistant", sessionID },
      parts: [{ type: "tool", callID: `call_${status}`, state: { status, error: "No tool result was produced." } }],
    })
    await hooks.event!({
      event: { type: "session.status", properties: { sessionID, status: { type: "busy" } } } as never,
    })
    await hooks.event!({
      event: { type: "session.status", properties: { sessionID, status: { type: "idle" } } } as never,
    })

    const paused = await requireTool(tools.get_goal, "get_goal").execute({}, context)
    expect(calls.filter((call) => call.path?.id === sessionID)).toHaveLength(2)
    expect(String(paused)).toContain('"status": "paused"')
    expect(String(paused)).toContain('"continuationFailures": 2')
  }
})

test("exact live OpenCode connection and provider-header timeout wording enters bounded transport recovery", async () => {
  const calls: { path?: { id?: string } }[] = []
  const hooks = await plugin.server(
    {
      client: {
        session: {
          promptAsync: async (input: { path?: { id?: string } }) => calls.push(input),
        },
      },
    } as never,
    { auto_continue: true, min_continue_interval_seconds: 0, max_prompt_failures: 3 },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")
  const liveErrors = [
    {
      name: "AI_APICallError",
      message: "Cannot connect to API: The socket connection was closed unexpectedly.",
    },
    {
      name: "ProviderHeaderTimeoutError",
      message: "Provider response headers timed out after 10000ms",
    },
  ]

  for (const [index, error] of liveErrors.entries()) {
    const sessionID = `ses_live_transport_${index}`
    const context = { sessionID } as never
    await requireTool(tools.create_goal, "create_goal").execute({ objective: "keep working" }, context)
    await hooks.event!({ event: { type: "session.error", properties: { sessionID, error } } as never })
    expect(String(await requireTool(tools.get_goal, "get_goal").execute({}, context))).toContain('"status": "active"')
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID } } as never })
    expect(calls.filter((call) => call.path?.id === sessionID)).toHaveLength(1)
  }
})

test("session errors stop continuation loops with native-aligned limit and terminal states", async () => {
  const calls: unknown[] = []
  const hooks = await plugin.server(
    {
      client: {
        session: {
          promptAsync: async (input: unknown) => calls.push(input),
        },
      },
    } as never,
    { auto_continue: true, min_continue_interval_seconds: 0 },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")
  await requireTool(tools.create_goal, "create_goal").execute(
    { objective: "usage goal" },
    { sessionID: "ses_usage" } as never,
  )
  await requireTool(tools.create_goal, "create_goal").execute(
    { objective: "terminal goal" },
    { sessionID: "ses_terminal" } as never,
  )

  await hooks.event!({
    event: {
      type: "session.error",
      properties: {
        sessionID: "ses_usage",
        error: { name: "APIError", message: "insufficient quota", statusCode: 429 },
      },
    } as never,
  })
  await hooks.event!({
    event: {
      type: "session.error",
      properties: {
        sessionID: "ses_terminal",
        error: { name: "ProviderError", message: "upstream stream failed", statusCode: 500 },
      },
    } as never,
  })
  await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_usage" } } as never })
  await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_terminal" } } as never })

  const usage = await requireTool(tools.get_goal, "get_goal").execute({}, { sessionID: "ses_usage" } as never)
  const terminal = await requireTool(tools.get_goal, "get_goal").execute({}, { sessionID: "ses_terminal" } as never)
  expect(String(usage)).toContain('"status": "usageLimited"')
  expect(String(usage)).toContain('"stopReason": "usage limit"')
  expect(String(terminal)).toContain('"status": "blocked"')
  expect(String(terminal)).toContain('"stopReason": "turn error"')
  expect(calls).toHaveLength(0)
})

test("context overflow compacts with the pinned model and continues the active goal", async () => {
  const summarizeCalls: unknown[] = []
  const continuationCalls: unknown[] = []
  const hooks = await plugin.server(
    {
      client: {
        session: {
          summarize: async (input: unknown) => {
            summarizeCalls.push(input)
            return { data: true }
          },
          promptAsync: async (input: unknown) => {
            continuationCalls.push(input)
          },
        },
      },
    } as never,
    { auto_continue: true, max_auto_turns: 5, min_continue_interval_seconds: 0 },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")
  const context = { sessionID: "ses_context", agent: "build" } as never

  await hooks["chat.message"]!(
    {
      sessionID: "ses_context",
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-5.6-sol" },
    } as never,
    {
      message: { sessionID: "ses_context", agent: "build" },
      parts: [{ type: "text", text: "Begin the long-running goal." }],
    } as never,
  )
  await requireTool(tools.create_goal, "create_goal").execute({ objective: "keep working" }, context)

  await hooks.event!({
    event: {
      type: "session.error",
      properties: {
        sessionID: "ses_context",
        error: {
          name: "APIError",
          data: { message: "context_length_exceeded: maximum context length is 272000 tokens" },
        },
      },
    } as never,
  })
  await waitForContinuation(continuationCalls)

  expect(summarizeCalls).toEqual([
    {
      path: { id: "ses_context" },
      body: { providerID: "openai", modelID: "gpt-5.6-sol" },
    },
  ])
  expect(continuationCalls).toHaveLength(1)
  expect(JSON.stringify(continuationCalls[0])).toContain("Continue working toward the active session goal")
  const read = await requireTool(tools.get_goal, "get_goal").execute({}, context)
  expect(String(read)).toContain('"status": "active"')
})

test("duplicate context overflow events launch one compaction and one continuation", async () => {
  let releaseSummarize: (() => void) | undefined
  const summarizeCalls: unknown[] = []
  const continuationCalls: unknown[] = []
  const hooks = await plugin.server(
    {
      client: {
        session: {
          summarize: async (input: unknown) => {
            summarizeCalls.push(input)
            await new Promise<void>((resolve) => {
              releaseSummarize = resolve
            })
            return { data: true }
          },
          promptAsync: async (input: unknown) => {
            continuationCalls.push(input)
          },
        },
      },
    } as never,
    { auto_continue: true, max_auto_turns: 5, min_continue_interval_seconds: 0 },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")
  const context = { sessionID: "ses_context_duplicate", agent: "build" } as never

  await hooks["chat.message"]!(
    {
      sessionID: "ses_context_duplicate",
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-5.6-sol-fast" },
    } as never,
    {
      message: { sessionID: "ses_context_duplicate", agent: "build" },
      parts: [{ type: "text", text: "Begin the long-running goal." }],
    } as never,
  )
  await requireTool(tools.create_goal, "create_goal").execute({ objective: "keep working" }, context)
  const contextError = {
    event: {
      type: "session.error",
      properties: {
        sessionID: "ses_context_duplicate",
        error: { name: "APIError", message: "maximum context length exceeded" },
      },
    } as never,
  }

  const first = hooks.event!(contextError)
  await waitFor(() => summarizeCalls.length === 1)
  await hooks.event!(contextError)
  expect(summarizeCalls).toHaveLength(1)
  releaseSummarize?.()
  await first
  await waitForContinuation(continuationCalls)

  expect(summarizeCalls).toHaveLength(1)
  expect(continuationCalls).toHaveLength(1)
})

test("failed context compaction blocks the goal without continuing", async () => {
  const continuationCalls: unknown[] = []
  const hooks = await plugin.server(
    {
      client: {
        session: {
          summarize: async () => {
            throw new Error("compaction transport failed")
          },
          promptAsync: async (input: unknown) => {
            continuationCalls.push(input)
          },
        },
      },
    } as never,
    { auto_continue: true, max_auto_turns: 5, min_continue_interval_seconds: 0 },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")
  const context = { sessionID: "ses_context_failure", agent: "build" } as never

  await hooks["chat.message"]!(
    {
      sessionID: "ses_context_failure",
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-5.6-terra" },
    } as never,
    {
      message: { sessionID: "ses_context_failure", agent: "build" },
      parts: [{ type: "text", text: "Begin the long-running goal." }],
    } as never,
  )
  await requireTool(tools.create_goal, "create_goal").execute({ objective: "keep working" }, context)
  await hooks.event!({
    event: {
      type: "session.error",
      properties: {
        sessionID: "ses_context_failure",
        error: { name: "APIError", message: "context_length_exceeded" },
      },
    } as never,
  })
  await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_context_failure" } } as never })

  const read = await requireTool(tools.get_goal, "get_goal").execute({}, context)
  expect(String(read)).toContain('"status": "blocked"')
  expect(String(read)).toContain("Context-overflow recovery failed: compaction transport failed")
  expect(continuationCalls).toHaveLength(0)
})

test("sequential context overflows compact once until explicit resume starts a new episode", async () => {
  const summarizeCalls: unknown[] = []
  const continuationCalls: unknown[] = []
  const hooks = await plugin.server(
    {
      client: {
        session: {
          summarize: async (input: unknown) => {
            summarizeCalls.push(input)
            return { data: true }
          },
          promptAsync: async (input: unknown) => continuationCalls.push(input),
        },
      },
    } as never,
    { auto_continue: true, max_auto_turns: 5, min_continue_interval_seconds: 0 },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")
  const sessionID = "ses_context_bounded"
  const context = { sessionID, agent: "build" } as never

  await hooks["chat.message"]!(
    { sessionID, agent: "build", model: { providerID: "openai", modelID: "gpt-5.6-sol" } } as never,
    {
      message: { sessionID, agent: "build" },
      parts: [{ type: "text", text: "Begin the long-running goal." }],
    } as never,
  )
  await requireTool(tools.create_goal, "create_goal").execute({ objective: "keep working" }, context)
  const nestedContextError = {
    event: {
      type: "session.error",
      properties: {
        sessionID,
        error: { name: "APIError", data: { error: { details: { code: "context_length_exceeded" } } } },
      },
    } as never,
  }

  await hooks.event!(nestedContextError)
  await waitForContinuation(continuationCalls)
  await hooks.event!(nestedContextError)

  expect(summarizeCalls).toHaveLength(1)
  let read = await requireTool(tools.get_goal, "get_goal").execute({}, context)
  expect(String(read)).toContain('"status": "blocked"')

  const resumed = await invokeGoalCommand(hooks, "resume", { sessionID, agent: "build" })
  expect(resumed).toContain("resumed the goal")
  await hooks.event!(nestedContextError)

  expect(summarizeCalls).toHaveLength(2)
  read = await requireTool(tools.get_goal, "get_goal").execute({}, context)
  expect(String(read)).toContain('"status": "active"')
})

test("a compaction summary cannot reset recovery for the continuation that overflowed", async () => {
  const summarizeCalls: unknown[] = []
  const continuationCalls: unknown[] = []
  const sessionID = "ses_context_compaction_summary"
  const model = { providerID: "openai", modelID: "gpt-5.6-sol" }
  const hookRef: { current?: Awaited<ReturnType<typeof plugin.server>> } = {}
  const hooks = await plugin.server(
    {
      client: {
        session: {
          summarize: async (input: unknown) => {
            summarizeCalls.push(input)
            if (!hookRef.current) throw new Error("expected plugin hooks during compaction")
            await hookRef.current.event!({
              event: {
                type: "message.updated",
                properties: {
                  info: { id: "msg_compaction_summary", sessionID, role: "assistant" },
                  message: { id: "msg_compaction_summary", sessionID, role: "assistant" },
                  parts: [{ type: "text", text: "Compaction summary for the turn that overflowed." }],
                },
              } as never,
            })
            return { data: true }
          },
          promptAsync: async (input: unknown) => {
            continuationCalls.push(input)
            const request = input as { body?: { agent?: string; model?: typeof model; parts?: unknown[] } }
            if (!hookRef.current) throw new Error("expected plugin hooks before auto-continuation")
            await hookRef.current["chat.message"]!(
              { sessionID, agent: request.body?.agent ?? "build", model: request.body?.model ?? model } as never,
              {
                message: { sessionID, agent: request.body?.agent ?? "build" },
                parts: structuredClone(request.body?.parts ?? []),
              } as never,
            )
          },
        },
      },
    } as never,
    { auto_continue: true, max_auto_turns: 5, min_continue_interval_seconds: 0 },
  )
  hookRef.current = hooks
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")
  const context = { sessionID, agent: "build" } as never

  await hooks["chat.message"]!(
    { sessionID, agent: "build", model } as never,
    { message: { sessionID, agent: "build" }, parts: [{ type: "text", text: "Begin." }] } as never,
  )
  await requireTool(tools.create_goal, "create_goal").execute({ objective: "keep working" }, context)
  await hooks.event!({ event: { type: "session.idle", properties: { sessionID } } as never })
  await waitForContinuation(continuationCalls)

  const contextError = {
    event: {
      type: "session.error",
      properties: { sessionID, error: { code: "context_length_exceeded" } },
    } as never,
  }
  await hooks.event!(contextError)
  await hooks.event!(contextError)

  expect(summarizeCalls).toHaveLength(1)
  const read = await requireTool(tools.get_goal, "get_goal").execute({}, context)
  expect(String(read)).toContain('"status": "blocked"')
})

test("assistant progress after the recovered auto-continuation resets the context recovery episode", async () => {
  const summarizeCalls: unknown[] = []
  const continuationCalls: unknown[] = []
  const sessionID = "ses_context_progress"
  const model = { providerID: "openai", modelID: "gpt-5.6-sol-fast" }
  const hookRef: { current?: Awaited<ReturnType<typeof plugin.server>> } = {}
  const hooks = await plugin.server(
    {
      client: {
        session: {
          summarize: async (input: unknown) => {
            summarizeCalls.push(input)
            return { data: true }
          },
          promptAsync: async (input: unknown) => {
            continuationCalls.push(input)
            const request = input as { body?: { agent?: string; model?: typeof model; parts?: unknown[] } }
            if (!hookRef.current) throw new Error("expected plugin hooks before auto-continuation")
            await hookRef.current["chat.message"]!(
              { sessionID, agent: request.body?.agent ?? "build", model: request.body?.model ?? model } as never,
              {
                message: { sessionID, agent: request.body?.agent ?? "build" },
                parts: structuredClone(request.body?.parts ?? []),
              } as never,
            )
          },
        },
      },
    } as never,
    { auto_continue: true, max_auto_turns: 5, min_continue_interval_seconds: 0 },
  )
  hookRef.current = hooks
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")
  const context = { sessionID, agent: "build" } as never

  await hooks["chat.message"]!(
    { sessionID, agent: "build", model } as never,
    { message: { sessionID, agent: "build" }, parts: [{ type: "text", text: "Begin." }] } as never,
  )
  await requireTool(tools.create_goal, "create_goal").execute({ objective: "keep working" }, context)
  const contextError = {
    event: {
      type: "session.error",
      properties: { sessionID, error: { code: "context_length_exceeded" } },
    } as never,
  }

  await hooks.event!(contextError)
  await waitForContinuation(continuationCalls)
  await hooks.event!({
    event: {
      type: "message.updated",
      properties: {
        info: { id: "msg_after_context_recovery", sessionID, role: "assistant" },
        message: { id: "msg_after_context_recovery", sessionID, role: "assistant" },
        parts: [{ type: "text", text: "Made concrete progress after compaction." }],
      },
    } as never,
  })
  await hooks.event!(contextError)

  expect(summarizeCalls).toHaveLength(2)
})

test("user steering during context compaction prevents a stale continuation", async () => {
  let releaseSummarize: (() => void) | undefined
  const continuationCalls: unknown[] = []
  const hooks = await plugin.server(
    {
      client: {
        session: {
          summarize: async () => {
            await new Promise<void>((resolve) => {
              releaseSummarize = resolve
            })
            return { data: true }
          },
          promptAsync: async (input: unknown) => continuationCalls.push(input),
        },
      },
    } as never,
    { auto_continue: true, max_auto_turns: 5, min_continue_interval_seconds: 0 },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")
  const sessionID = "ses_context_steered"
  const context = { sessionID, agent: "build" } as never
  const model = { providerID: "openai", modelID: "gpt-5.6-terra" }

  await hooks["chat.message"]!(
    { sessionID, agent: "build", model } as never,
    { message: { sessionID, agent: "build" }, parts: [{ type: "text", text: "Begin." }] } as never,
  )
  await requireTool(tools.create_goal, "create_goal").execute({ objective: "keep working" }, context)
  const recovery = hooks.event!({
    event: {
      type: "session.error",
      properties: { sessionID, error: { message: "maximum context length exceeded" } },
    } as never,
  })
  await waitFor(() => releaseSummarize !== undefined)
  await hooks["chat.message"]!(
    { sessionID, agent: "build", model } as never,
    { message: { sessionID, agent: "build" }, parts: [{ type: "text", text: "User steering during compaction." }] } as never,
  )
  releaseSummarize?.()
  await recovery
  await new Promise((resolve) => setTimeout(resolve, 300))

  expect(continuationCalls).toHaveLength(0)
  const read = await requireTool(tools.get_goal, "get_goal").execute({}, context)
  expect(String(read)).toContain('"status": "active"')
})

test("session deletion during context compaction prevents a stale continuation", async () => {
  let releaseSummarize: (() => void) | undefined
  const continuationCalls: unknown[] = []
  const hooks = await plugin.server(
    {
      client: {
        session: {
          summarize: async () => {
            await new Promise<void>((resolve) => {
              releaseSummarize = resolve
            })
            return { data: true }
          },
          promptAsync: async (input: unknown) => continuationCalls.push(input),
        },
      },
    } as never,
    { auto_continue: true, max_auto_turns: 5, min_continue_interval_seconds: 0 },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")
  const sessionID = "ses_context_deleted"
  const context = { sessionID, agent: "build" } as never

  await hooks["chat.message"]!(
    {
      sessionID,
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-5.6-luna" },
    } as never,
    { message: { sessionID, agent: "build" }, parts: [{ type: "text", text: "Begin." }] } as never,
  )
  await requireTool(tools.create_goal, "create_goal").execute({ objective: "keep working" }, context)
  const recovery = hooks.event!({
    event: {
      type: "session.error",
      properties: { sessionID, error: { message: "context length exceeded" } },
    } as never,
  })
  await waitFor(() => releaseSummarize !== undefined)
  await hooks.event!({ event: { type: "session.deleted", properties: { info: { id: sessionID } } } as never })
  releaseSummarize?.()
  await recovery
  await new Promise((resolve) => setTimeout(resolve, 300))

  expect(continuationCalls).toHaveLength(0)
})

test("manual OpenCode interruption pauses the goal across duplicate idle events until explicit resume", async () => {
  const calls: unknown[] = []
  const hooks = await plugin.server(
    {
      client: {
        session: {
          promptAsync: async (input: unknown) => calls.push(input),
        },
      },
    } as never,
    { auto_continue: true, min_continue_interval_seconds: 0 },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")
  const context = { sessionID: "ses_interrupted" } as never
  await requireTool(tools.create_goal, "create_goal").execute({ objective: "keep working" }, context)

  await hooks.event!({
    event: {
      type: "session.error",
      properties: {
        sessionID: "ses_interrupted",
        error: { name: "MessageAbortedError", data: { message: "Aborted" } },
      },
    } as never,
  })
  for (let duplicate = 0; duplicate < 2; duplicate += 1) {
    await hooks.event!({
      event: {
        type: "session.status",
        properties: { sessionID: "ses_interrupted", status: { type: "idle" } },
      } as never,
    })
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_interrupted" } } as never })
  }

  const paused = await requireTool(tools.get_goal, "get_goal").execute({}, context)
  expect(String(paused)).toContain('"status": "paused"')
  expect(String(paused)).toContain('"stopReason": "user interrupt"')
  expect(String(paused)).toContain("Run /goal resume to continue")
  expect(calls).toHaveLength(0)

  const resumed = await invokeGoalCommand(hooks, "resume", { sessionID: "ses_interrupted", agent: "build" })
  expect(resumed).toContain("resumed the goal")
  await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_interrupted" } } as never })
  expect(calls).toHaveLength(1)
})

test("ordinary pasted command markers cannot mutate goal state", async () => {
  const hooks = await plugin.server(
    { client: { session: { promptAsync: async () => {} } } } as never,
    { auto_continue: false },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")
  const context = { sessionID: "ses_1" } as never
  await requireTool(tools.create_goal, "create_goal").execute({ objective: "keep this goal" }, context)

  await hooks["chat.message"]!(
    { sessionID: "ses_1", agent: "build" } as never,
    {
      message: { sessionID: "ses_1", agent: "build" },
      parts: [
        {
          type: "text",
          text: '<slash-goal-for-opencode-command name="goal">\nclear\n</slash-goal-for-opencode-command>',
        },
      ],
    } as never,
  )

  const read = await requireTool(tools.get_goal, "get_goal").execute({}, context)
  expect(String(read)).toContain('"objective": "keep this goal"')
  expect(String(read)).toContain('"status": "active"')
})

test("only clear, edit, pause, and resume are reserved goal control words", async () => {
  const hooks = await plugin.server(
    { client: { session: { promptAsync: async () => {} } } } as never,
    { auto_continue: false },
  )
  const tools = hooks.tool
  if (!tools) throw new Error("expected goal tools to be registered")

  const ordinaryObjectives = ["status", "show", "current", "history", "stop", "off", "reset", "none", "cancel"]
  for (const [index, objective] of ordinaryObjectives.entries()) {
    const sessionID = `ses_alias_${index}`
    const result = await invokeGoalCommand(hooks, objective, { sessionID })
    const read = await requireTool(tools.get_goal, "get_goal").execute({}, { sessionID } as never)
    expect(result).toContain("created the goal")
    expect(String(read)).toContain(`"objective": "${objective}"`)
  }
})
