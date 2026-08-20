import type { TuiCommand, TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { Plugin as TuiPluginV2 } from "@opencode-ai/plugin-v2/tui"
import type { SessionMessageInfo } from "@opencode-ai/client"
import { createElement, insert, setProp } from "@opentui/solid"
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"

type GoalCheckpoint = {
  summary: string
  timestamp: number
}

type GoalHistoryEntry = {
  type: string
  detail: string
  timestamp: number
}

type GoalSnapshot = {
  sessionID: string
  objective: string
  status: "active" | "paused" | "budgetLimited" | "usageLimited" | "complete" | "unmet"
  tokenBudget: number | null
  tokensUsed: number
  timeUsedSeconds: number
  createdAt: number
  updatedAt: number
  completionEvidence?: string | null
  blocker?: string | null
  closedAt?: number | null
  continuationFailures: number
  lastStatus: string | null
  maxAutoTurns: number | null
  maxDurationSeconds: number | null
  noProgressTokenThreshold: number | null
  maxNoProgressTurns: number | null
  noProgressTurns: number
  budgetWrapupSent: boolean
  stopReason: string | null
  history: GoalHistoryEntry[]
  checkpoints: GoalCheckpoint[]
  lastCheckpoint: GoalCheckpoint | null
  lastAssistantText: string
  lastAssistantMessageID: string
  autoTurns: number
  lastContinuationAt: number | null
  remainingTokens: number | null
  sampledAt?: number
}

type GoalToolPart = {
  type: string
  tool?: string
  state?: {
    status?: string
    output?: string
  }
  tokens?: unknown
}

type SessionMessage = {
  id: string
}

type GoalSessionState = {
  goal: GoalSnapshot | null
  messageIndex: number
}
type ElementChild = string | number | boolean | null | undefined | object | (() => ElementChild)

type ModernTuiApi = TuiPluginApi & {
  keymap?: {
    registerLayer?: (layer: {
      commands: {
        namespace: string
        name: string
        title: string
        desc?: string
        category?: string
        run?: () => void
      }[]
      bindings?: unknown[]
    }) => () => void
  }
}

const goalCache = new Map<string, GoalSnapshot>()

const GOAL_TOOL_NAMES: readonly string[] = [
  "get_goal",
  "get_goal_history",
  "create_goal",
  "set_goal",
  "update_goal",
  "update_goal_objective",
  "update_goal_status",
  "clear_goal",
]

function element(tag: string, props: Record<string, unknown>, children: ElementChild[] = []) {
  const node = createElement(tag)
  for (const [key, value] of Object.entries(props)) if (value !== undefined) setProp(node, key, value)
  for (const child of children) if (child !== null && child !== undefined && child !== false) insert(node, child)
  return node
}

function text(props: Record<string, unknown>, children: ElementChild[]) {
  return element("text", props, children)
}

function box(props: Record<string, unknown>, children: ElementChild[] = []) {
  return element("box", props, children)
}

type SlotRender = (props: { sessionID: string }) => unknown
type SlotDispose = () => void

const noopDispose: SlotDispose = () => {}

/**
 * Registers a V2 TUI slot across both plugin-context generations.
 *
 * Early V2 previews exposed `ui.slot(name, render)`. Current previews expose a
 * single options argument, `ui.slot({ append, render })`, and silently register
 * nothing when handed the positional pair — which is how the goal sidebar and
 * the palette keymap layer both disappeared. Branch on the callback arity so
 * either host works, and tolerate hosts that return no disposer.
 */
export function registerSlotV2(context: TuiPluginV2.Context, name: string, render: SlotRender): SlotDispose {
  const slot = context.ui.slot as unknown as (...args: unknown[]) => unknown
  const dispose = slot.length <= 1 ? slot({ append: name, render }) : slot(name, render)
  return typeof dispose === "function" ? (dispose as SlotDispose) : noopDispose
}

/**
 * Reads a theme color by trying each candidate path in order, descending into a
 * `default` leaf when the resolved node is a color group.
 *
 * Current previews expose a nested theme (`text.default`, `text.subdued`,
 * `text.feedback.success`), while earlier previews and the V1 TUI expose flat
 * keys (`text`, `textMuted`, `primary`). Passing a color *group* as `fg`
 * renders nothing useful, so resolve to a leaf before handing it to OpenTUI.
 */
export function themeColorV2(theme: unknown, ...paths: readonly (readonly string[])[]): unknown {
  for (const path of paths) {
    let cursor: unknown = theme
    for (const key of path) {
      if (cursor === null || typeof cursor !== "object") {
        cursor = undefined
        break
      }
      cursor = (cursor as Record<string, unknown>)[key]
    }
    if (cursor !== null && typeof cursor === "object" && "default" in (cursor as Record<string, unknown>)) {
      cursor = (cursor as Record<string, unknown>).default
    }
    if (cursor !== undefined && cursor !== null) return cursor
  }
  return undefined
}

function goalColorsV2(theme: unknown) {
  return {
    text: themeColorV2(theme, ["text", "default"], ["text"]),
    muted: themeColorV2(theme, ["text", "subdued"], ["textMuted"]),
    achieved: themeColorV2(theme, ["text", "feedback", "success"], ["primary"], ["text", "default"], ["text"]),
  }
}

function goalSnapshotKey(sessionID: string) {
  return `goal-mode.snapshot.${sessionID}`
}

function cachedGoal(api: TuiPluginApi, sessionID: string) {
  const memory = goalCache.get(sessionID)
  if (memory) return memory
  const persisted = api.kv?.get(goalSnapshotKey(sessionID), null)
  return isGoalSnapshot(persisted) ? persisted : null
}

function cacheGoal(api: TuiPluginApi, sessionID: string, goal: GoalSnapshot | null) {
  if (goal) {
    goalCache.set(sessionID, goal)
    api.kv?.set(goalSnapshotKey(sessionID), goal)
    return
  }
  goalCache.delete(sessionID)
  api.kv?.set(goalSnapshotKey(sessionID), null)
}

function currentSessionID(api: TuiPluginApi) {
  const route = api.route.current
  if (route.name !== "session") return undefined
  const sessionID = route.params?.sessionID
  return typeof sessionID === "string" ? sessionID : undefined
}

function toast(api: TuiPluginApi, message: string, variant: "info" | "success" | "warning" | "error" = "info") {
  api.ui.toast({ title: "Goal", message, variant, duration: 2500 })
}

async function sendGoalPrompt(api: TuiPluginApi, sessionID: string, text: string) {
  await api.client.session.promptAsync({
    sessionID,
    parts: [{ type: "text", text }],
  })
}

function refreshGoalPrompt() {
  return "Call get_goal for this session and report the current goal state briefly."
}

function clearGoalPrompt() {
  return "Clear the current session goal by calling clear_goal. Report whether a goal was cleared."
}

function pauseGoalPrompt() {
  return 'Pause the current session goal by calling update_goal_status with status "paused". Report the result briefly.'
}

function resumeGoalPrompt() {
  return 'Resume the current session goal by calling update_goal_status with status "active", then continue working toward it.'
}

function historyGoalPrompt() {
  return "Call get_goal_history for this session and report the current goal history briefly."
}

function actionOption(api: TuiPluginApi, sessionID: string, title: string, value: string, description: string, prompt: string) {
  return {
    title,
    value,
    description,
    onSelect: () => {
      void sendGoalPrompt(api, sessionID, prompt)
        .then(() => api.ui.dialog.clear())
        .catch((error) => toast(api, error instanceof Error ? error.message : String(error), "error"))
    },
  }
}

function showSummary(api: TuiPluginApi, sessionID: string, goal: GoalSnapshot | null) {
  const DialogSelect = api.ui.DialogSelect
  const options = [
    actionOption(api, sessionID, "Refresh", "refresh", "Ask the agent to read the current goal state", refreshGoalPrompt()),
    ...(goal
      ? [
          actionOption(api, sessionID, "History", "history", "Ask the agent to show lifecycle history", historyGoalPrompt()),
          ...(goal.status === "active"
            ? [actionOption(api, sessionID, "Pause", "pause", "Pause auto-continuation without clearing", pauseGoalPrompt())]
            : []),
          ...(goal.status === "paused" || goal.status === "budgetLimited" || goal.status === "usageLimited"
            ? [actionOption(api, sessionID, "Resume", "resume", "Resume the goal and continue", resumeGoalPrompt())]
            : []),
          actionOption(api, sessionID, "Clear", "clear", "Ask the agent to clear this session goal", clearGoalPrompt()),
        ]
      : []),
  ]

  api.ui.dialog.setSize("large")
  api.ui.dialog.replace(() =>
    DialogSelect({
      title: "Goal",
      placeholder: formatGoal(goal),
      options,
      onSelect(option) {
        option.onSelect?.()
      },
    }),
  )
}

function sessionIDOrToast(api: TuiPluginApi) {
  const sessionID = currentSessionID(api)
  if (!sessionID) toast(api, "Open a session before viewing goal state.", "warning")
  return sessionID
}

export function formatDuration(seconds: number) {
  const total = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  const paddedSecs = String(secs).padStart(2, "0")
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${paddedSecs}`
  return `${minutes}:${paddedSecs}`
}

function formatDurationBadge(seconds: number) {
  return formatDuration(seconds)
}

function currentEpochSeconds() {
  return Math.floor(Date.now() / 1000)
}

export function liveTimeUsedSeconds(goal: GoalSnapshot, nowSeconds = currentEpochSeconds()) {
  const baseSeconds = Math.max(0, Math.floor(goal.timeUsedSeconds))
  if (goal.status !== "active") return baseSeconds
  if (typeof goal.sampledAt !== "number") return baseSeconds
  return baseSeconds + Math.max(0, Math.floor(nowSeconds - goal.sampledAt))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isCheckpoint(value: unknown): value is GoalCheckpoint {
  return isRecord(value) && typeof value.summary === "string" && typeof value.timestamp === "number"
}

function isHistoryEntry(value: unknown): value is GoalHistoryEntry {
  return isRecord(value) && typeof value.type === "string" && typeof value.detail === "string" && typeof value.timestamp === "number"
}

function isGoalSnapshot(value: unknown): value is GoalSnapshot {
  if (!isRecord(value)) return false
  if (typeof value.sessionID !== "string") return false
  if (typeof value.objective !== "string") return false
  if (!["active", "paused", "budgetLimited", "usageLimited", "complete", "unmet"].includes(String(value.status))) return false
  if (value.tokenBudget !== null && typeof value.tokenBudget !== "number") return false
  if (typeof value.tokensUsed !== "number") return false
  if (typeof value.timeUsedSeconds !== "number") return false
  if (typeof value.createdAt !== "number") return false
  if (typeof value.updatedAt !== "number") return false
  if (value.completionEvidence != null && typeof value.completionEvidence !== "string") return false
  if (value.blocker != null && typeof value.blocker !== "string") return false
  if (value.closedAt != null && typeof value.closedAt !== "number") return false
  if (typeof value.continuationFailures !== "number") return false
  if (value.lastStatus != null && typeof value.lastStatus !== "string") return false
  if (value.maxAutoTurns !== null && typeof value.maxAutoTurns !== "number") return false
  if (value.maxDurationSeconds !== null && typeof value.maxDurationSeconds !== "number") return false
  if (value.noProgressTokenThreshold !== null && typeof value.noProgressTokenThreshold !== "number") return false
  if (value.maxNoProgressTurns !== null && typeof value.maxNoProgressTurns !== "number") return false
  if (typeof value.noProgressTurns !== "number") return false
  if (typeof value.budgetWrapupSent !== "boolean") return false
  if (value.stopReason !== null && typeof value.stopReason !== "string") return false
  if (!Array.isArray(value.history) || !value.history.every(isHistoryEntry)) return false
  if (!Array.isArray(value.checkpoints) || !value.checkpoints.every(isCheckpoint)) return false
  if (value.lastCheckpoint !== null && !isCheckpoint(value.lastCheckpoint)) return false
  if (typeof value.lastAssistantText !== "string") return false
  if (typeof value.lastAssistantMessageID !== "string") return false
  if (typeof value.autoTurns !== "number") return false
  if (value.lastContinuationAt != null && typeof value.lastContinuationAt !== "number") return false
  if (value.remainingTokens !== null && typeof value.remainingTokens !== "number") return false
  if (value.sampledAt != null && typeof value.sampledAt !== "number") return false
  return true
}

function parseGoalToolOutput(part: GoalToolPart): GoalSnapshot | null | undefined {
  if (part.type !== "tool") return undefined
  if (!GOAL_TOOL_NAMES.includes(part.tool ?? "")) return undefined
  if (part.state?.status !== "completed") return undefined
  if (part.tool === "clear_goal") return null
  if (typeof part.state.output !== "string") return undefined

  try {
    const parsed: unknown = JSON.parse(part.state.output)
    if (!isRecord(parsed)) return undefined
    if (parsed.goal === null) return null
    return isGoalSnapshot(parsed.goal) ? parsed.goal : undefined
  } catch {
    return undefined
  }
}

export function goalStateFromSession(api: TuiPluginApi, sessionID: string): GoalSessionState {
  const messages = [...api.state.session.messages(sessionID)] as SessionMessage[]
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex]
    if (!message) continue
    const parts = [...api.state.part(message.id)].reverse() as GoalToolPart[]
    for (const part of parts) {
      const goal = parseGoalToolOutput(part)
      if (goal !== undefined) {
        cacheGoal(api, sessionID, goal)
        return { goal, messageIndex }
      }
    }
  }
  return { goal: cachedGoal(api, sessionID), messageIndex: -1 }
}

function goalFromSession(api: TuiPluginApi, sessionID: string) {
  return goalStateFromSession(api, sessionID).goal
}

function formatGoal(goal: GoalSnapshot | null) {
  if (!goal) return "No recent goal state found in this session."
  const lines = [
    `Objective: ${goal.objective}`,
    `Status: ${goal.status}`,
    `Time used: ${formatDuration(goal.timeUsedSeconds)}`,
    `Tokens: ${goal.tokensUsed}${goal.tokenBudget == null ? "" : `/${goal.tokenBudget}`}`,
    `Auto-continues: ${goal.autoTurns}${goal.maxAutoTurns == null ? "" : `/${goal.maxAutoTurns}`}`,
  ]
  if (goal.remainingTokens != null) lines.push(`Tokens remaining: ${goal.remainingTokens}`)
  if (goal.maxDurationSeconds != null) lines.push(`Duration limit: ${formatDuration(goal.maxDurationSeconds)}`)
  if (goal.noProgressTurns > 0) lines.push(`No-progress turns: ${goal.noProgressTurns}`)
  if (goal.lastCheckpoint) lines.push(`Latest checkpoint: ${goal.lastCheckpoint.summary}`)
  if (goal.stopReason) lines.push(`Stop reason: ${goal.stopReason}`)
  if (goal.lastStatus) lines.push(`Last status: ${goal.lastStatus}`)
  if (goal.completionEvidence) lines.push(`Completion evidence: ${goal.completionEvidence}`)
  if (goal.blocker) lines.push(`Blocker: ${goal.blocker}`)
  return lines.join("\n")
}

function GoalSidebar(api: TuiPluginApi, sessionID: string) {
  const theme = api.theme.current
  const state = goalStateFromSession(api, sessionID)
  const goal = state.goal
  if (!goal) return null
  if (goal.status === "complete" || goal.status === "unmet") {
    const elapsed = liveTimeUsedSeconds(goal)
    return text({ fg: goal.status === "complete" ? theme.primary : theme.textMuted }, [`${goal.status === "complete" ? "Goal achieved" : "Goal unmet"} (${formatDurationBadge(elapsed)})`])
  }
  const [nowSeconds, setNowSeconds] = createSignal(currentEpochSeconds())
  if (goal.status === "active") {
    const timer = setInterval(() => setNowSeconds(currentEpochSeconds()), 1000)
    onCleanup(() => clearInterval(timer))
  }
  return box({}, [
    text({ fg: theme.text }, ["Goal"]),
    text({ fg: theme.textMuted }, [`Status: ${goal.status}`]),
    text({ fg: theme.textMuted }, [() => `Time: ${formatDuration(liveTimeUsedSeconds(goal, nowSeconds()))}`]),
    text({ fg: theme.textMuted }, [`Tokens: ${goal.tokensUsed}${goal.tokenBudget == null ? "" : `/${goal.tokenBudget}`}`]),
    text({ fg: theme.textMuted }, [`Auto-continues: ${goal.autoTurns}${goal.maxAutoTurns == null ? "" : `/${goal.maxAutoTurns}`}`]),
    ...(goal.lastCheckpoint ? [text({ fg: theme.textMuted }, [`Checkpoint: ${goal.lastCheckpoint.summary}`])] : []),
    ...(goal.stopReason ? [text({ fg: theme.textMuted }, [`Stop: ${goal.stopReason}`])] : []),
    ...(goal.lastStatus ? [text({ fg: theme.textMuted }, [goal.lastStatus])] : []),
    text({ fg: theme.textMuted }, [goal.objective]),
  ])
}

function registerGoalCommand(api: TuiPluginApi, command: TuiCommand) {
  const modern = api as ModernTuiApi
  if (modern.keymap?.registerLayer) {
    modern.keymap.registerLayer({
      commands: [
        {
          namespace: "palette",
          name: command.value,
          title: command.title,
          desc: command.description,
          category: command.category,
          run: command.onSelect,
        },
      ],
      bindings: [],
    })
    return
  }
  api.command?.register(() => [command])
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 125,
    slots: {
      sidebar_content(_ctx, props) {
        return GoalSidebar(api, props.session_id)
      },
    },
  })

  registerGoalCommand(api, {
    title: "Goal",
    value: "goal.show",
    category: "Goal",
    description: "View, pause, resume, or clear the long-running session goal",
    onSelect: () => {
      const sessionID = sessionIDOrToast(api)
      if (!sessionID) return
      showSummary(api, sessionID, goalFromSession(api, sessionID))
    },
  })
}

// --- V2 TUI plugin ---

/**
 * Scans the V2 session message list for the newest completed goal tool result.
 * Assistant tool content entries carry `name` plus a completed `state.content`
 * array; goal tool output is serialized in text ToolContent parts. Returns
 * `undefined` when no goal tool output is present (so callers can fall back to
 * a cached snapshot), `null` after a completed clear_goal, or the snapshot.
 */
export function goalFromV2Messages(messages: readonly SessionMessageInfo[]): GoalSnapshot | null | undefined {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex]
    if (!message || message.type !== "assistant") continue
    const parts = message.content
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = parts[partIndex]
      if (!part || part.type !== "tool") continue
      if (!GOAL_TOOL_NAMES.includes(part.name)) continue
      if (part.state.status !== "completed") continue
      if (part.name === "clear_goal") return null
      const textContent = part.state.content.find((entry) => entry.type === "text")
      if (!textContent) continue
      try {
        const parsed: unknown = JSON.parse(textContent.text)
        if (!isRecord(parsed)) continue
        if (parsed.goal === null) return null
        if (isGoalSnapshot(parsed.goal)) return parsed.goal
      } catch {
        // Malformed tool output: keep scanning older tool entries.
      }
    }
  }
  return undefined
}

function currentSessionIDV2(api: TuiPluginV2.Context) {
  const route = api.ui.router.current()
  if (route.type !== "session") return undefined
  return route.sessionID
}

function toastV2(api: TuiPluginV2.Context, message: string, variant: "info" | "success" | "warning" | "error" = "info") {
  api.ui.toast.show({ title: "Goal", message, variant, duration: 2500 })
}

async function showSummaryV2(api: TuiPluginV2.Context, sessionID: string, goal: GoalSnapshot | null) {
  const options = [
    { title: "Refresh", value: "refresh", description: "Ask the agent to read the current goal state" },
    ...(goal
      ? [
          { title: "History", value: "history", description: "Ask the agent to show lifecycle history" },
          ...(goal.status === "active"
            ? [{ title: "Pause", value: "pause", description: "Pause auto-continuation without clearing" }]
            : []),
          ...(goal.status === "paused" || goal.status === "budgetLimited" || goal.status === "usageLimited"
            ? [{ title: "Resume", value: "resume", description: "Resume the goal and continue" }]
            : []),
          { title: "Clear", value: "clear", description: "Ask the agent to clear this session goal" },
        ]
      : []),
  ]
  api.ui.dialog.set({ size: "large" })
  const selected = await api.ui.dialog.select({ title: "Goal", placeholder: formatGoal(goal), options })
  const prompt = selected === "refresh" ? refreshGoalPrompt()
    : selected === "history" ? historyGoalPrompt()
    : selected === "pause" ? pauseGoalPrompt()
    : selected === "resume" ? resumeGoalPrompt()
    : selected === "clear" ? clearGoalPrompt()
    : undefined
  if (!prompt) return
  try {
    await api.client.session.prompt({ sessionID, text: prompt })
  } catch (error) {
    toastV2(api, error instanceof Error ? error.message : String(error), "error")
  }
}

function GoalSidebarV2(api: TuiPluginV2.Context, sessionID: string) {
  const colors = goalColorsV2(api.theme)
  const [cache, setCache] = api.storage.memory<{ goal: GoalSnapshot | null }>(`goal-mode.v2.${sessionID}`, {
    initial: { goal: null },
  })
  const goal = createMemo<GoalSnapshot | null>(() => {
    const found = goalFromV2Messages(api.data.session.message.list(sessionID))
    return found === undefined ? cache.goal : found
  })
  createEffect(() =>
    setCache((draft) => {
      draft.goal = goal()
    }),
  )

  const [nowSeconds, setNowSeconds] = createSignal(currentEpochSeconds())
  createEffect(() => {
    if (goal()?.status !== "active") return
    const timer = setInterval(() => setNowSeconds(currentEpochSeconds()), 1000)
    onCleanup(() => clearInterval(timer))
  })
  return box({}, [() => {
    const snapshot = goal()
    if (!snapshot) return null
    if (snapshot.status === "complete" || snapshot.status === "unmet") {
      const elapsed = liveTimeUsedSeconds(snapshot)
      return text({ fg: snapshot.status === "complete" ? colors.achieved : colors.muted }, [
        `${snapshot.status === "complete" ? "Goal achieved" : "Goal unmet"} (${formatDurationBadge(elapsed)})`,
      ])
    }
    return box({}, [
      text({ fg: colors.text }, ["Goal"]),
      text({ fg: colors.muted }, [`Status: ${snapshot.status}`]),
      text({ fg: colors.muted }, [`Time: ${formatDuration(liveTimeUsedSeconds(snapshot, nowSeconds()))}`]),
      text({ fg: colors.muted }, [`Tokens: ${snapshot.tokensUsed}${snapshot.tokenBudget == null ? "" : `/${snapshot.tokenBudget}`}`]),
      text({ fg: colors.muted }, [`Auto-continues: ${snapshot.autoTurns}${snapshot.maxAutoTurns == null ? "" : `/${snapshot.maxAutoTurns}`}`]),
      ...(snapshot.lastCheckpoint ? [text({ fg: colors.muted }, [`Checkpoint: ${snapshot.lastCheckpoint.summary}`])] : []),
      ...(snapshot.stopReason ? [text({ fg: colors.muted }, [`Stop: ${snapshot.stopReason}`])] : []),
      ...(snapshot.lastStatus ? [text({ fg: colors.muted }, [snapshot.lastStatus])] : []),
      text({ fg: colors.muted }, [snapshot.objective]),
    ])
  }])
}

function GoalKeymapLayerV2(api: TuiPluginV2.Context) {
  api.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "goal.show",
        title: "Goal",
        description: "View, pause, resume, or clear the long-running session goal",
        group: "Goal",
        palette: true,
        run: () => {
          const sessionID = currentSessionIDV2(api)
          if (!sessionID) {
            toastV2(api, "Open a session before viewing goal state.", "warning")
            return
          }
          void showSummaryV2(api, sessionID, goalFromV2Messages(api.data.session.message.list(sessionID)) ?? null)
        },
      },
    ],
  }))
  return null
}

/**
 * V2 TUI setup: registers the goal sidebar via `ui.slot` and a palette command
 * through a keymap layer mounted from the global `app` slot. `keymap.layer`
 * must be invoked from a Solid component scope, so the layer lives inside a
 * component rendered by the `app` slot; its cleanup is owned by that component
 * and released automatically when the slot unmounts. The setup cleanup only
 * needs to dispose the two `ui.slot` registrations.
 */
export function setupTuiV2(context: TuiPluginV2.Context): TuiPluginV2.Cleanup {
  const offSidebar = registerSlotV2(context, "sidebar.content", (props) => GoalSidebarV2(context, props.sessionID))
  const offApp = registerSlotV2(context, "app", () => GoalKeymapLayerV2(context))
  return () => {
    offSidebar()
    offApp()
  }
}

const plugin: TuiPluginModule & TuiPluginV2.Definition = {
  id: "local.goal-mode.tui",
  tui,
  setup: setupTuiV2,
}

export default plugin
