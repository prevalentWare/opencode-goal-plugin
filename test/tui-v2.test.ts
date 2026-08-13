import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import { createStore, type Store } from "solid-js/store"
import type { SessionMessageAssistantTool, SessionMessageInfo } from "@opencode-ai/client"
import plugin, {
  goalFromV2Messages,
  liveTimeUsedSeconds,
  registerSlotV2,
  setupTuiV2,
  themeColorV2,
} from "../src/tui.ts"

type GoalSnapshot = Parameters<typeof liveTimeUsedSeconds>[0]

function goal(overrides: Partial<GoalSnapshot> = {}): GoalSnapshot {
  return {
    sessionID: "session",
    objective: "test goal",
    status: "active",
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 10,
    createdAt: 90,
    updatedAt: 100,
    completionEvidence: null,
    blocker: null,
    closedAt: null,
    continuationFailures: 0,
    lastStatus: "Goal set.",
    maxAutoTurns: null,
    maxDurationSeconds: null,
    noProgressTokenThreshold: 50,
    maxNoProgressTurns: 2,
    noProgressTurns: 0,
    budgetWrapupSent: false,
    stopReason: null,
    history: [],
    checkpoints: [],
    lastCheckpoint: null,
    lastAssistantText: "",
    lastAssistantMessageID: "",
    autoTurns: 0,
    lastContinuationAt: null,
    remainingTokens: null,
    sampledAt: 100,
    ...overrides,
  }
}

function assistantMessage(id: string, content: SessionMessageAssistantTool[]): SessionMessageInfo {
  return {
    id,
    time: { created: 0 },
    type: "assistant",
    agent: "build",
    model: { id: "model", providerID: "provider" },
    content,
  } as SessionMessageInfo
}

function goalTool(name: string, text: string): SessionMessageAssistantTool {
  return {
    type: "tool",
    id: `call_${name}`,
    name,
    state: { status: "completed", input: {}, content: [{ type: "text", text }] },
    time: { created: 0 },
  } as SessionMessageAssistantTool
}

function errorTool(name: string): SessionMessageAssistantTool {
  return {
    type: "tool",
    id: `call_${name}`,
    name,
    state: { status: "error", input: {}, error: { type: "error", message: "boom" } },
    time: { created: 0 },
  } as SessionMessageAssistantTool
}

type MockKeymapLayer = {
  mode?: string
  enabled?: boolean | (() => boolean)
  target?: unknown
  priority?: number
  commands?: readonly {
    id?: string
    title?: string
    description?: string
    group?: string
    palette?: true
    run: (input?: string, event?: unknown) => void | false | Promise<void>
  }[]
  bindings?: readonly string[]
}

type MockContext = {
  options: Record<string, unknown>
  location: undefined
  app: { version: string; channel: string }
  renderer: unknown
  client: {
    session: {
      prompt: (input: { sessionID: string; text: string }) => Promise<unknown>
    }
  }
  data: {
    session: {
      message: { list: (sessionID: string) => SessionMessageInfo[] }
    }
  }
  attention: unknown
  theme: {
    text: {
      default: string
      subdued: string
      feedback: { success: { default: string } }
    }
  }
  markdown: unknown
  keymap: {
    layer: (input: () => MockKeymapLayer) => void
  }
  storage: {
    memory: (
      key: string,
      options: { initial: { goal: GoalSnapshot | null } },
    ) => readonly [
      Store<{ goal: GoalSnapshot | null }>,
      (mutation: (draft: { goal: GoalSnapshot | null }) => void) => void,
    ]
    store: (...args: unknown[]) => never
  }
  ui: {
    dialog: {
      set: (options: { size?: string }) => void
      select: (options: { title: string; placeholder: string; options: readonly { title: string; value: string }[] }) => Promise<string | undefined>
      clear: () => void
    }
    toast: {
      show: (options: { title?: string; message: string; variant?: string; duration?: number }) => void
    }
    format: { path: (value: string) => string }
    router: {
      register: () => () => void
      navigate: () => void
      current: () => { type: string; sessionID?: string }
    }
    tabs: unknown
    slot: (options: { append: string; render: (props: { sessionID: string }) => unknown }) => () => void
  }
}

function makeMockContext(overrides: Partial<MockContext> = {}): {
  mock: MockContext
  slots: Map<string, (props: { sessionID: string }) => unknown>
  disposed: string[]
  layers: Array<() => MockKeymapLayer>
  promptCalls: Array<{ sessionID: string; text: string }>
  toasts: Array<{ title?: string; message: string; variant?: string; duration?: number }>
  selectCalls: Array<{ title: string; placeholder: string; options: readonly { title: string; value: string }[] }>
  setMessages: (messages: SessionMessageInfo[]) => void
  setRoute: (route: { type: string; sessionID?: string }) => void
} {
  const slots = new Map<string, (props: { sessionID: string }) => unknown>()
  const disposed: string[] = []
  const layers: Array<() => MockKeymapLayer> = []
  const promptCalls: Array<{ sessionID: string; text: string }> = []
  const toasts: Array<{ title?: string; message: string; variant?: string; duration?: number }> = []
  const selectCalls: Array<{ title: string; placeholder: string; options: readonly { title: string; value: string }[] }> = []
  const [messages, setMessages] = createSignal<SessionMessageInfo[]>([])
  let route: { type: string; sessionID?: string } = { type: "home" }

  const memories = new Map<string, [Store<{ goal: GoalSnapshot | null }>, (mutation: (draft: { goal: GoalSnapshot | null }) => void) => void]>()

  const mock: MockContext = {
    options: {},
    location: undefined,
    app: { version: "0.0.0", channel: "test" },
    renderer: undefined,
    client: {
      session: {
        async prompt(input) {
          promptCalls.push(input)
          return { id: "pending_1" }
        },
      },
    },
    data: {
      session: {
        message: {
          list() {
            return messages()
          },
        },
      },
    },
    attention: undefined,
    theme: {
      text: {
        default: "#ffffff",
        subdued: "#888888",
        feedback: { success: { default: "#00ff00" } },
      },
    },
    markdown: undefined,
    keymap: {
      layer(input) {
        layers.push(input)
      },
    },
    storage: {
      memory(key, options) {
        let entry = memories.get(key)
        if (!entry) {
          const [store, setStore] = createStore<{ goal: GoalSnapshot | null }>({ ...options.initial })
          entry = [
            store,
            (mutation) => {
              const draft = { ...store }
              mutation(draft)
              setStore(draft)
            },
          ]
          memories.set(key, entry)
        }
        return entry
      },
      store() {
        throw new Error("storage.store is not used in these tests")
      },
    },
    ui: {
      dialog: {
        set() {},
        async select(options) {
          selectCalls.push(options)
          return undefined
        },
        clear() {},
      },
      toast: {
        show(options) {
          toasts.push(options)
        },
      },
      format: { path: (value) => value },
      router: {
        register: () => () => {},
        navigate: () => {},
        current: () => route,
      },
      tabs: undefined,
      // Current previews take a single options argument. Keep the arity at 1 so
      // the plugin exercises the same call shape the real host uses.
      slot(options) {
        slots.set(options.append, options.render)
        return () => {
          disposed.push(options.append)
        }
      },
    },
  }

  return {
    mock: { ...mock, ...overrides },
    slots,
    disposed,
    layers,
    promptCalls,
    toasts,
    selectCalls,
    setMessages(next) {
      setMessages(next)
    },
    setRoute(next) {
      route = next
    },
  }
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 1000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  expect(predicate()).toBe(true)
}

test("V2 TUI definition exposes id and a setup function", () => {
  expect(plugin.id).toBe("local.goal-mode.tui")
  expect(typeof plugin.setup).toBe("function")
  expect(typeof plugin.tui).toBe("function")
})

test("registerSlotV2 uses the options argument when the host takes one parameter", () => {
  const calls: Array<{ append: string; render: unknown }> = []
  const context = {
    ui: {
      slot: (options: { append: string; render: () => unknown }) => {
        calls.push(options)
        return () => {}
      },
    },
  }
  const render = () => null

  const dispose = registerSlotV2(context as never, "sidebar.content", render)

  expect(calls).toEqual([{ append: "sidebar.content", render }])
  expect(typeof dispose).toBe("function")
})

test("registerSlotV2 falls back to the positional form on earlier previews", () => {
  const calls: Array<[string, unknown]> = []
  const context = {
    ui: {
      slot: (name: string, render: () => unknown) => {
        calls.push([name, render])
        return () => {}
      },
    },
  }
  const render = () => null

  registerSlotV2(context as never, "app", render)

  expect(calls).toEqual([["app", render]])
})

test("registerSlotV2 tolerates hosts that do not return a disposer", () => {
  const context = { ui: { slot: (_options: { append: string }) => undefined } }

  const dispose = registerSlotV2(context as never, "sidebar.content", () => null)

  expect(typeof dispose).toBe("function")
  expect(() => dispose()).not.toThrow()
})

test("themeColorV2 resolves nested, grouped, and legacy flat theme colors", () => {
  const nested = {
    text: { default: "#ffffff", subdued: "#888888", feedback: { success: { default: "#00ff00" } } },
  }
  const flat = { text: "#eeeeee", textMuted: "#777777", primary: "#00cc00" }

  expect(themeColorV2(nested, ["text", "default"], ["text"])).toBe("#ffffff")
  expect(themeColorV2(nested, ["text", "subdued"], ["textMuted"])).toBe("#888888")
  // A color group resolves to its `default` leaf rather than the group object.
  expect(themeColorV2(nested, ["text", "feedback", "success"], ["primary"])).toBe("#00ff00")

  expect(themeColorV2(flat, ["text", "default"], ["text"])).toBe("#eeeeee")
  expect(themeColorV2(flat, ["text", "subdued"], ["textMuted"])).toBe("#777777")
  expect(themeColorV2(flat, ["text", "feedback", "success"], ["primary"])).toBe("#00cc00")

  expect(themeColorV2({}, ["text", "default"], ["text"])).toBeUndefined()
})

test("V2 setup registers sidebar.content and app slots and cleanup disposes them", () => {
  const { mock, slots, disposed } = makeMockContext()
  const cleanup = setupTuiV2(mock as never)

  expect(slots.has("sidebar.content")).toBe(true)
  expect(slots.has("app")).toBe(true)
  expect(disposed).toEqual([])

  cleanup()
  expect(disposed.sort()).toEqual(["app", "sidebar.content"])
})

test("goalFromV2Messages parses the newest completed goal tool output from text ToolContent", () => {
  const snapshot = goal({ status: "paused", objective: "paused goal", lastStatus: "Goal paused." })
  const messages = [
    assistantMessage("created", [goalTool("create_goal", JSON.stringify({ goal: goal({ objective: "first goal" }) }))]),
    assistantMessage("paused", [goalTool("update_goal_status", JSON.stringify({ goal: snapshot }))]),
  ]

  const result = goalFromV2Messages(messages)
  expect(result?.status).toBe("paused")
  expect(result?.objective).toBe("paused goal")
  expect(result?.lastStatus).toBe("Goal paused.")
})

test("goalFromV2Messages ignores non-goal tools, error states, file content, and malformed JSON", () => {
  const snapshot = goal({ objective: "real goal" })
  const messages = [
    assistantMessage("created", [
      goalTool("task", JSON.stringify({ task: "unrelated" })),
      errorTool("create_goal"),
      {
        type: "tool",
        id: "call_get_goal",
        name: "get_goal",
        state: {
          status: "completed",
          input: {},
          content: [
            { type: "file", uri: "file:///tmp/out.json", mime: "application/json" },
            { type: "text", text: JSON.stringify({ goal: snapshot }) },
          ],
        },
        time: { created: 0 },
      } as SessionMessageAssistantTool,
      goalTool("update_goal", "{ not valid json"),
    ]),
  ]

  const result = goalFromV2Messages(messages)
  expect(result?.objective).toBe("real goal")
})

test("goalFromV2Messages returns null after a completed clear_goal", () => {
  const messages = [
    assistantMessage("created", [goalTool("create_goal", JSON.stringify({ goal: goal() }))]),
    assistantMessage("cleared", [goalTool("clear_goal", "")]),
  ]
  expect(goalFromV2Messages(messages)).toBeNull()
})

test("goalFromV2Messages returns undefined when no goal tool output exists", () => {
  expect(goalFromV2Messages([])).toBeUndefined()
  expect(goalFromV2Messages([assistantMessage("plain", [])])).toBeUndefined()
  expect(goalFromV2Messages([{ id: "user", type: "user", time: { created: 0 } } as SessionMessageInfo])).toBeUndefined()
})

test("V2 sidebar renders the parsed goal from session messages", async () => {
  const { mock, slots, setMessages } = makeMockContext()
  const cleanup = setupTuiV2(mock as never)
  const sidebar = slots.get("sidebar.content")
  expect(sidebar).toBeTypeOf("function")

  setMessages([
    assistantMessage("created", [goalTool("create_goal", JSON.stringify({ goal: goal({ objective: "ship the v2 milestone", status: "paused" }) }))]),
  ])

  const setup = await testRender(() => sidebar?.({ sessionID: "session" }) as never, { width: 80, height: 20 })
  let destroyed = false
  try {
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Goal")
    expect(frame).toContain("Status: paused")
    expect(frame).toContain("ship the v2 milestone")
    expect(frame).toContain("Tokens: 0")
    setup.renderer.destroy()
    destroyed = true
  } finally {
    if (!destroyed) setup.renderer.destroy()
    cleanup()
  }
})

test("V2 sidebar shows a completion badge for complete goals", async () => {
  const { mock, slots, setMessages } = makeMockContext()
  const cleanup = setupTuiV2(mock as never)
  const sidebar = slots.get("sidebar.content")

  setMessages([
    assistantMessage("completed", [
      goalTool("update_goal", JSON.stringify({ goal: goal({ status: "complete", completionEvidence: "verified" }) })),
    ]),
  ])

  const setup = await testRender(() => sidebar?.({ sessionID: "session" }) as never, { width: 80, height: 20 })
  let destroyed = false
  try {
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("Goal achieved")
    setup.renderer.destroy()
    destroyed = true
  } finally {
    if (!destroyed) setup.renderer.destroy()
    cleanup()
  }
})

test("V2 sidebar reacts when goal tool results arrive after mount", async () => {
  const { mock, slots, setMessages } = makeMockContext()
  const cleanup = setupTuiV2(mock as never)
  const sidebar = slots.get("sidebar.content")
  const setup = await testRender(() => sidebar?.({ sessionID: "session" }) as never, { width: 80, height: 20 })
  let destroyed = false
  try {
    await setup.renderOnce()
    expect(setup.captureCharFrame()).not.toContain("late goal")

    setMessages([
      assistantMessage("created", [goalTool("create_goal", JSON.stringify({ goal: goal({ objective: "late goal" }) }))]),
    ])
    await setup.flush()
    expect(setup.captureCharFrame()).toContain("late goal")
    expect(setup.captureCharFrame()).toContain("Status: active")

    setMessages([
      assistantMessage("paused", [
        goalTool("update_goal_status", JSON.stringify({ goal: goal({ objective: "late goal", status: "paused" }) })),
      ]),
    ])
    await setup.flush()
    expect(setup.captureCharFrame()).toContain("Status: paused")
    setup.renderer.destroy()
    destroyed = true
  } finally {
    if (!destroyed) setup.renderer.destroy()
    cleanup()
  }
})

test("V2 keymap layer registers the goal palette command when the app slot renders", async () => {
  const { mock, slots, layers } = makeMockContext()
  const cleanup = setupTuiV2(mock as never)
  const app = slots.get("app")
  expect(app).toBeTypeOf("function")

  const setup = await testRender(() => app?.({ sessionID: "" }) as never, { width: 80, height: 20 })
  let destroyed = false
  try {
    await setup.renderOnce()
    expect(layers).toHaveLength(1)
    const layer = layers[0]?.()
    const command = layer?.commands?.find((candidate) => candidate.id === "goal.show")
    expect(command).toBeDefined()
    expect(command?.title).toBe("Goal")
    expect(command?.palette).toBe(true)
    // Without an explicit global mode the host never surfaces the command in
    // the palette, even while the layer itself is registered.
    expect(layer?.mode).toBe("global")
    setup.renderer.destroy()
    destroyed = true
  } finally {
    if (!destroyed) setup.renderer.destroy()
    cleanup()
  }
})

test("V2 palette command prompts the agent through client.session.prompt after dialog.select", async () => {
  const { mock, slots, layers, setMessages, setRoute, selectCalls, promptCalls, toasts } = makeMockContext()
  mock.ui.dialog.select = async (options) => {
    selectCalls.push(options)
    return "resume"
  }
  const cleanup = setupTuiV2(mock as never)
  const app = slots.get("app")
  expect(app).toBeTypeOf("function")

  setMessages([
    assistantMessage("paused", [
      goalTool("update_goal_status", JSON.stringify({ goal: goal({ status: "paused", objective: "resume me" }) })),
    ]),
  ])
  setRoute({ type: "session", sessionID: "ses_v2" })

  const setup = await testRender(() => app?.({ sessionID: "" }) as never, { width: 80, height: 20 })
  let destroyed = false
  try {
    await setup.renderOnce()
    const command = layers[0]?.()?.commands?.find((candidate) => candidate.id === "goal.show")
    expect(command).toBeDefined()
    command?.run()

    await waitFor(() => selectCalls.length === 1)
    expect(selectCalls[0]?.placeholder).toContain("resume me")
    expect(selectCalls[0]?.options.map((option) => option.title)).toEqual(
      expect.arrayContaining(["Refresh", "History", "Resume", "Clear"]),
    )

    await waitFor(() => promptCalls.length === 1)
    expect(promptCalls[0]).toEqual({
      sessionID: "ses_v2",
      text: expect.stringContaining('update_goal_status with status "active"'),
    })
    expect(toasts).toEqual([])

    setup.renderer.destroy()
    destroyed = true
  } finally {
    if (!destroyed) setup.renderer.destroy()
    cleanup()
  }
})

test("V2 palette command toasts a warning when no session is open", async () => {
  const { mock, slots, layers, toasts, setRoute, selectCalls, promptCalls } = makeMockContext()
  const cleanup = setupTuiV2(mock as never)
  setRoute({ type: "home" })

  const app = slots.get("app")
  expect(app).toBeTypeOf("function")
  const setup = await testRender(() => app?.({ sessionID: "" }) as never, { width: 80, height: 20 })
  let destroyed = false
  try {
    await setup.renderOnce()
    const command = layers[0]?.()?.commands?.find((candidate) => candidate.id === "goal.show")
    command?.run()
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(toasts).toHaveLength(1)
    expect(toasts[0]?.message).toContain("Open a session")
    expect(toasts[0]?.variant).toBe("warning")
    expect(selectCalls).toHaveLength(0)
    expect(promptCalls).toHaveLength(0)

    setup.renderer.destroy()
    destroyed = true
  } finally {
    if (!destroyed) setup.renderer.destroy()
    cleanup()
  }
})
