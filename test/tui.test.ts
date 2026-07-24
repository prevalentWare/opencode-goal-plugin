import { expect, setSystemTime, spyOn, test } from "bun:test"
import { testRender } from "@opentui/solid"
import plugin, { formatDuration, goalStateFromSession, liveTimeUsedSeconds } from "../src/tui.ts"

function goal(overrides: Partial<Parameters<typeof liveTimeUsedSeconds>[0]> = {}): Parameters<typeof liveTimeUsedSeconds>[0] {
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

test("tui plugin registers goal sidebar and status command without hijacking /goal", async () => {
  let registered: (() => { value: string; slash?: { name: string } }[]) | undefined
  let sidebar: ((ctx: unknown, props: { session_id: string }) => unknown) | undefined
  const api = {
    slots: {
      register(input: { slots: { sidebar_content: (ctx: unknown, props: { session_id: string }) => unknown } }) {
        sidebar = input.slots.sidebar_content
        return "slot-id"
      },
    },
    command: {
      register(cb: () => { value: string; slash?: { name: string } }[]) {
        registered = cb
        return () => {}
      },
    },
    route: { current: { name: "home" } },
    ui: {
      toast() {},
      dialog: {
        setSize() {},
        replace() {},
        clear() {},
      },
    },
    theme: {
      current: {
        text: "#ffffff",
        textMuted: "#888888",
      },
    },
    state: {
      session: {
        messages() {
          return []
        },
      },
    },
  }
  await plugin.tui(api as never, undefined, undefined as never)

  const commands = registered?.() ?? []
  expect(commands.map((command) => command.value).sort()).toEqual(["goal.show"])
  expect(commands.flatMap((command) => (command.slash ? [command.slash.name] : [])).sort()).toEqual([])
  expect(typeof sidebar?.({}, { session_id: "session" })).not.toBe("string")
})

test("reads goal state from native get_goal output", () => {
  const snapshot = goal({ status: "paused", objective: "paused goal", lastStatus: "Goal paused." })
  const api = {
    state: {
      session: {
        messages() {
          return [{ id: "paused" }]
        },
      },
      part() {
        return [
          {
            type: "tool",
            tool: "get_goal",
            state: { status: "completed", output: JSON.stringify({ goal: snapshot }) },
          },
        ]
      },
    },
  }

  expect(goalStateFromSession(api as never, "session").goal?.status).toBe("paused")
  expect(goalStateFromSession(api as never, "session").goal?.lastStatus).toBe("Goal paused.")
})

test("live goal time advances from the authoritative snapshot sample time", () => {
  expect(liveTimeUsedSeconds(goal(), 130)).toBe(40)
  expect(liveTimeUsedSeconds(goal({ status: "paused" }), 130)).toBe(10)
  expect(liveTimeUsedSeconds(goal({ status: "complete" }), 130)).toBe(10)
  expect(liveTimeUsedSeconds(goal({ sampledAt: undefined }), 130)).toBe(10)
})

test("active goal sidebar advances visible elapsed time after a timer tick", async () => {
  const intervalCallbacks: (() => void)[] = []
  const timer = 1 as unknown as ReturnType<typeof setInterval>
  const setIntervalSpy = spyOn(globalThis, "setInterval").mockImplementation(((callback: unknown, delay?: number) => {
    if (delay === 1000 && typeof callback === "function") {
      intervalCallbacks.push(() => callback())
      return timer
    }
    throw new Error(`Unexpected interval delay: ${delay}`)
  }) as unknown as typeof setInterval)
  const clearIntervalSpy = spyOn(globalThis, "clearInterval").mockImplementation(() => {})
  let sidebar: ((ctx: unknown, props: { session_id: string }) => unknown) | undefined
  const snapshot = goal()
  const api = {
    slots: {
      register(input: { slots: { sidebar_content: (ctx: unknown, props: { session_id: string }) => unknown } }) {
        sidebar = input.slots.sidebar_content
        return "slot-id"
      },
    },
    command: {
      register() {
        return () => {}
      },
    },
    route: { current: { name: "session", params: { sessionID: "session" } } },
    ui: {
      toast() {},
      dialog: {
        setSize() {},
        replace() {},
        clear() {},
      },
    },
    theme: {
      current: {
        text: "#ffffff",
        textMuted: "#888888",
        primary: "#00ff00",
      },
    },
    state: {
      session: {
        messages() {
          return [{ id: "active" }]
        },
      },
      part() {
        return [{ type: "tool", tool: "create_goal", state: { status: "completed", output: JSON.stringify({ goal: snapshot }) } }]
      },
    },
    kv: {
      get(_key: string, fallback: unknown) {
        return fallback
      },
      set() {},
    },
  }

  setSystemTime(new Date(100_000))
  await plugin.tui(api as never, undefined, undefined as never)
  const setup = await testRender(() => sidebar?.({}, { session_id: "session" }) as never, { width: 80, height: 20 })
  let destroyed = false
  try {
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("Time: 0:10")

    setSystemTime(new Date(105_000))
    for (const callback of intervalCallbacks) callback()
    await setup.flush()

    expect(setup.captureCharFrame()).toContain("Time: 0:15")
    setup.renderer.destroy()
    destroyed = true
    expect(clearIntervalSpy).toHaveBeenCalledWith(timer)
  } finally {
    if (!destroyed) setup.renderer.destroy()
    clearIntervalSpy.mockRestore()
    setIntervalSpy.mockRestore()
    setSystemTime()
  }
})

test("formats goal durations for display", () => {
  expect(formatDuration(0)).toBe("0:00")
  expect(formatDuration(65)).toBe("1:05")
  expect(formatDuration(74305)).toBe("20:38:25")
  expect(formatDuration(-1)).toBe("0:00")
})

test("keeps the last goal visible when a newer turn has no goal tool output", () => {
  const snapshot = goal({ sessionID: "cache-session", objective: "cached goal" })
  const messages = [{ id: "created" }, { id: "new-user-message" }]
  const partsByMessage = new Map([
    [
      "created",
      [
        {
          type: "tool",
          tool: "create_goal",
          state: { status: "completed", output: JSON.stringify({ goal: snapshot }) },
        },
      ],
    ],
    ["new-user-message", [{ type: "text" }]],
  ])
  const api = {
    state: {
      session: {
        messages() {
          return messages
        },
      },
      part(messageID: string) {
        return partsByMessage.get(messageID) ?? []
      },
    },
  }

  expect(goalStateFromSession(api as never, "cache-session").goal?.objective).toBe("cached goal")

  partsByMessage.set("created", [])
  expect(goalStateFromSession(api as never, "cache-session").goal?.objective).toBe("cached goal")
})

test("restores the goal indicator from persistent tui cache when message history is gone", () => {
  const snapshot = goal({ sessionID: "kv-cache-session", objective: "persisted goal" })
  const kv = new Map<string, unknown>([["goal-mode.snapshot.kv-cache-session", snapshot]])
  const api = {
    kv: {
      get(key: string, fallback?: unknown) {
        return kv.has(key) ? kv.get(key) : fallback
      },
      set(key: string, value: unknown) {
        kv.set(key, value)
      },
    },
    state: {
      session: {
        messages() {
          return []
        },
      },
      part() {
        return []
      },
    },
  }

  expect(goalStateFromSession(api as never, "kv-cache-session").goal?.objective).toBe("persisted goal")
})

test("clears the cached goal after get_goal reports no goal", () => {
  const snapshot = goal({ sessionID: "clear-cache-session", objective: "goal to clear" })
  const messages = [{ id: "created" }]
  const partsByMessage = new Map([
    [
      "created",
      [
        {
          type: "tool",
          tool: "create_goal",
          state: { status: "completed", output: JSON.stringify({ goal: snapshot }) },
        },
      ],
    ],
  ])
  const api = {
    state: {
      session: {
        messages() {
          return messages
        },
      },
      part(messageID: string) {
        return partsByMessage.get(messageID) ?? []
      },
    },
  }

  expect(goalStateFromSession(api as never, "clear-cache-session").goal?.objective).toBe("goal to clear")

  messages.push({ id: "cleared" })
  partsByMessage.set("cleared", [
    { type: "tool", tool: "get_goal", state: { status: "completed", output: JSON.stringify({ goal: null }) } },
  ])

  expect(goalStateFromSession(api as never, "clear-cache-session").goal).toBeNull()
})
