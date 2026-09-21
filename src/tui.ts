import type { TuiCommand, TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { Plugin as TuiPluginV2 } from "@opencode/plugin/tui"
import type { SessionMessageInfo } from "@opencode/client"
import { createElement, insert, setProp } from "@opentui/solid"
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import type { GoalMessages } from "./i18n"
import { messagesFor, presentGoalStatus, presentGoalStopReason, resolveLocale } from "./i18n"

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

function toast(
  api: TuiPluginApi,
  messages: GoalMessages,
  message: string,
  variant: "info" | "success" | "warning" | "error" = "info",
) {
  api.ui.toast({ title: messages.tui.title, message, variant, duration: 2500 })
}

async function sendGoalPrompt(api: TuiPluginApi, sessionID: string, text: string) {
  await api.client.session.promptAsync({
    sessionID,
    parts: [{ type: "text", text }],
  })
}

function refreshGoalPrompt(messages: GoalMessages) {
  return messages.tui.refreshPrompt
}

function clearGoalPrompt(messages: GoalMessages) {
  return messages.tui.clearPrompt
}

function pauseGoalPrompt(messages: GoalMessages) {
  return messages.tui.pausePrompt
}

function resumeGoalPrompt(messages: GoalMessages) {
  return messages.tui.resumePrompt
}

function historyGoalPrompt(messages: GoalMessages) {
  return messages.tui.historyPrompt
}

function actionOption(
  api: TuiPluginApi,
  messages: GoalMessages,
  sessionID: string,
  title: string,
  value: string,
  description: string,
  prompt: string,
) {
  return {
    title,
    value,
    description,
    onSelect: () => {
      void sendGoalPrompt(api, sessionID, prompt)
        .then(() => api.ui.dialog.clear())
        .catch((error) => toast(api, messages, error instanceof Error ? error.message : String(error), "error"))
    },
  }
}

function showSummary(
  api: TuiPluginApi,
  messages: GoalMessages,
  locale: ReturnType<typeof resolveLocale>,
  sessionID: string,
  goal: GoalSnapshot | null,
) {
  const DialogSelect = api.ui.DialogSelect
  const options = [
    actionOption(api, messages, sessionID, messages.tui.refresh, "refresh", messages.tui.refreshDescription, refreshGoalPrompt(messages)),
    ...(goal
      ? [
          actionOption(api, messages, sessionID, messages.tui.history, "history", messages.tui.historyDescription, historyGoalPrompt(messages)),
          ...(goal.status === "active"
            ? [actionOption(api, messages, sessionID, messages.tui.pause, "pause", messages.tui.pauseDescription, pauseGoalPrompt(messages))]
            : []),
          ...(goal.status === "paused" || goal.status === "budgetLimited" || goal.status === "usageLimited"
            ? [actionOption(api, messages, sessionID, messages.tui.resume, "resume", messages.tui.resumeDescription, resumeGoalPrompt(messages))]
            : []),
          actionOption(api, messages, sessionID, messages.tui.clear, "clear", messages.tui.clearDescription, clearGoalPrompt(messages)),
        ]
      : []),
  ]

  api.ui.dialog.setSize("large")
  api.ui.dialog.replace(() =>
    DialogSelect({
      title: messages.tui.title,
      placeholder: formatGoal(goal, messages, locale),
      options,
      onSelect(option) {
        option.onSelect?.()
      },
    }),
  )
}

function sessionIDOrToast(api: TuiPluginApi, messages: GoalMessages) {
  const sessionID = currentSessionID(api)
  if (!sessionID) toast(api, messages, messages.tui.openSession, "warning")
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

export function formatGoal(goal: GoalSnapshot | null, messages: GoalMessages, locale: ReturnType<typeof resolveLocale>) {
  if (!goal) return messages.tui.noGoal
  const lines = [
    `${messages.tui.objective}: ${goal.objective}`,
    `${messages.tui.status}: ${presentGoalStatus(goal.status, locale)}`,
    `${messages.tui.timeUsed}: ${formatDuration(goal.timeUsedSeconds)}`,
    `${messages.tui.tokens}: ${goal.tokensUsed}${goal.tokenBudget == null ? "" : `/${goal.tokenBudget}`}`,
    `${messages.tui.autoContinues}: ${goal.autoTurns}${goal.maxAutoTurns == null ? "" : `/${goal.maxAutoTurns}`}`,
  ]
  if (goal.remainingTokens != null) lines.push(`${messages.tui.tokensRemaining}: ${goal.remainingTokens}`)
  if (goal.maxDurationSeconds != null) lines.push(`${messages.tui.durationLimit}: ${formatDuration(goal.maxDurationSeconds)}`)
  if (goal.noProgressTurns > 0) lines.push(`${messages.tui.noProgressTurns}: ${goal.noProgressTurns}`)
  if (goal.lastCheckpoint) lines.push(`${messages.tui.latestCheckpoint}: ${goal.lastCheckpoint.summary}`)
  if (goal.stopReason) lines.push(`${messages.tui.stopReason}: ${presentGoalStopReason(goal.stopReason, locale)}`)
  if (goal.lastStatus) lines.push(`${messages.tui.lastStatus}: ${goal.lastStatus}`)
  if (goal.completionEvidence) lines.push(`${messages.tui.completionEvidence}: ${goal.completionEvidence}`)
  if (goal.blocker) lines.push(`${messages.tui.blocker}: ${goal.blocker}`)
  return lines.join("\n")
}

function GoalSidebar(api: TuiPluginApi, messages: GoalMessages, locale: ReturnType<typeof resolveLocale>, sessionID: string) {
  const theme = api.theme.current
  const state = goalStateFromSession(api, sessionID)
  const goal = state.goal
  if (!goal) return null
  if (goal.status === "complete" || goal.status === "unmet") {
    const elapsed = liveTimeUsedSeconds(goal)
    return text({ fg: goal.status === "complete" ? theme.primary : theme.textMuted }, [`${goal.status === "complete" ? messages.tui.achieved : messages.tui.unmet} (${formatDurationBadge(elapsed)})`])
  }
  const [nowSeconds, setNowSeconds] = createSignal(currentEpochSeconds())
  if (goal.status === "active") {
    const timer = setInterval(() => setNowSeconds(currentEpochSeconds()), 1000)
    onCleanup(() => clearInterval(timer))
  }
  return box({}, [
    text({ fg: theme.text }, [messages.tui.title]),
    text({ fg: theme.textMuted }, [`${messages.tui.status}: ${presentGoalStatus(goal.status, locale)}`]),
    text({ fg: theme.textMuted }, [() => `${messages.tui.time}: ${formatDuration(liveTimeUsedSeconds(goal, nowSeconds()))}`]),
    text({ fg: theme.textMuted }, [`${messages.tui.tokens}: ${goal.tokensUsed}${goal.tokenBudget == null ? "" : `/${goal.tokenBudget}`}`]),
    text({ fg: theme.textMuted }, [`${messages.tui.autoContinues}: ${goal.autoTurns}${goal.maxAutoTurns == null ? "" : `/${goal.maxAutoTurns}`}`]),
    ...(goal.lastCheckpoint ? [text({ fg: theme.textMuted }, [`${messages.tui.checkpoint}: ${goal.lastCheckpoint.summary}`])] : []),
    ...(goal.stopReason ? [text({ fg: theme.textMuted }, [`${messages.tui.stop}: ${presentGoalStopReason(goal.stopReason, locale)}`])] : []),
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

const tui: TuiPlugin = async (api, options) => {
  const locale = resolveLocale(typeof options?.locale === "string" ? options.locale : undefined)
  const messages = messagesFor(locale)
  api.slots.register({
    order: 125,
    slots: {
      sidebar_content(_ctx, props) {
        return GoalSidebar(api, messages, locale, props.session_id)
      },
    },
  })

  registerGoalCommand(api, {
    title: messages.tui.title,
    value: "goal.show",
    category: messages.tui.title,
    description: messages.tui.commandDescription,
    onSelect: () => {
      const sessionID = sessionIDOrToast(api, messages)
      if (!sessionID) return
      showSummary(api, messages, locale, sessionID, goalFromSession(api, sessionID))
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

function toastV2(
  api: TuiPluginV2.Context,
  messages: GoalMessages,
  message: string,
  variant: "info" | "success" | "warning" | "error" = "info",
) {
  api.ui.toast.show({ title: messages.tui.title, message, variant, duration: 2500 })
}

async function showSummaryV2(
  api: TuiPluginV2.Context,
  messages: GoalMessages,
  locale: ReturnType<typeof resolveLocale>,
  sessionID: string,
  goal: GoalSnapshot | null,
) {
  const options = [
    { title: messages.tui.refresh, value: "refresh", description: messages.tui.refreshDescription },
    ...(goal
      ? [
          { title: messages.tui.history, value: "history", description: messages.tui.historyDescription },
          ...(goal.status === "active"
            ? [{ title: messages.tui.pause, value: "pause", description: messages.tui.pauseDescription }]
            : []),
          ...(goal.status === "paused" || goal.status === "budgetLimited" || goal.status === "usageLimited"
            ? [{ title: messages.tui.resume, value: "resume", description: messages.tui.resumeDescription }]
            : []),
          { title: messages.tui.clear, value: "clear", description: messages.tui.clearDescription },
        ]
      : []),
  ]
  api.ui.dialog.set({ size: "large" })
  const selected = await api.ui.dialog.select({ title: messages.tui.title, placeholder: formatGoal(goal, messages, locale), options })
  const prompt = selected === "refresh" ? refreshGoalPrompt(messages)
    : selected === "history" ? historyGoalPrompt(messages)
    : selected === "pause" ? pauseGoalPrompt(messages)
    : selected === "resume" ? resumeGoalPrompt(messages)
    : selected === "clear" ? clearGoalPrompt(messages)
    : undefined
  if (!prompt) return
  try {
    await api.client.session.prompt({ sessionID, text: prompt })
  } catch (error) {
    toastV2(api, messages, error instanceof Error ? error.message : String(error), "error")
  }
}

function GoalSidebarV2(
  api: TuiPluginV2.Context,
  messages: GoalMessages,
  locale: ReturnType<typeof resolveLocale>,
  sessionID: string,
) {
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
        `${snapshot.status === "complete" ? messages.tui.achieved : messages.tui.unmet} (${formatDurationBadge(elapsed)})`,
      ])
    }
    return box({}, [
      text({ fg: colors.text }, [messages.tui.title]),
      text({ fg: colors.muted }, [`${messages.tui.status}: ${presentGoalStatus(snapshot.status, locale)}`]),
      text({ fg: colors.muted }, [`${messages.tui.time}: ${formatDuration(liveTimeUsedSeconds(snapshot, nowSeconds()))}`]),
      text({ fg: colors.muted }, [`${messages.tui.tokens}: ${snapshot.tokensUsed}${snapshot.tokenBudget == null ? "" : `/${snapshot.tokenBudget}`}`]),
      text({ fg: colors.muted }, [`${messages.tui.autoContinues}: ${snapshot.autoTurns}${snapshot.maxAutoTurns == null ? "" : `/${snapshot.maxAutoTurns}`}`]),
      ...(snapshot.lastCheckpoint ? [text({ fg: colors.muted }, [`${messages.tui.checkpoint}: ${snapshot.lastCheckpoint.summary}`])] : []),
      ...(snapshot.stopReason ? [text({ fg: colors.muted }, [`${messages.tui.stop}: ${presentGoalStopReason(snapshot.stopReason, locale)}`])] : []),
      ...(snapshot.lastStatus ? [text({ fg: colors.muted }, [snapshot.lastStatus])] : []),
      text({ fg: colors.muted }, [snapshot.objective]),
    ])
  }])
}

function GoalKeymapLayerV2(api: TuiPluginV2.Context, messages: GoalMessages, locale: ReturnType<typeof resolveLocale>) {
  api.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "goal.show",
        title: messages.tui.title,
        description: messages.tui.commandDescription,
        group: messages.tui.title,
        palette: true,
        run: () => {
          const sessionID = currentSessionIDV2(api)
          if (!sessionID) {
            toastV2(api, messages, messages.tui.openSession, "warning")
            return
          }
          void showSummaryV2(api, messages, locale, sessionID, goalFromV2Messages(api.data.session.message.list(sessionID)) ?? null)
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
  const locale = resolveLocale(typeof context.options?.locale === "string" ? context.options.locale : undefined)
  const messages = messagesFor(locale)
  const offSidebar = registerSlotV2(context, "sidebar.content", (props) => GoalSidebarV2(context, messages, locale, props.sessionID))
  const offApp = registerSlotV2(context, "app", () => GoalKeymapLayerV2(context, messages, locale))
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
