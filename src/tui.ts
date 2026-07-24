import type { TuiCommand, TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createElement, insert, setProp } from "@opentui/solid"
import { createSignal, onCleanup } from "solid-js"

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
  status: "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete"
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
  lastPromptAgent?: string | null
  lastPromptModel?: { providerID: string; modelID: string } | null
  blockedAuditTurns?: number
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
type ElementChild = string | number | boolean | null | undefined | object | (() => string)

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

async function sendGoalCommand(api: TuiPluginApi, sessionID: string, args: string) {
  await api.client.session.command({
    sessionID,
    command: "goal",
    arguments: args,
  })
}

function refreshGoalPrompt() {
  return ""
}

function clearGoalPrompt() {
  return "clear"
}

function pauseGoalPrompt() {
  return "pause"
}

function resumeGoalPrompt() {
  return "resume"
}

function actionOption(api: TuiPluginApi, sessionID: string, title: string, value: string, description: string, prompt: string) {
  return {
    title,
    value,
    description,
    onSelect: () => {
      void sendGoalCommand(api, sessionID, prompt)
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
          ...(goal.status === "active"
            ? [actionOption(api, sessionID, "Pause", "pause", "Pause auto-continuation without clearing", pauseGoalPrompt())]
            : []),
          ...(goal.status === "paused" || goal.status === "blocked" || goal.status === "budgetLimited" || goal.status === "usageLimited"
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
  if (!["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"].includes(String(value.status))) return false
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
  if (value.lastPromptAgent != null && typeof value.lastPromptAgent !== "string") return false
  if (
    value.lastPromptModel != null &&
    (!isRecord(value.lastPromptModel) ||
      typeof value.lastPromptModel.providerID !== "string" ||
      typeof value.lastPromptModel.modelID !== "string")
  )
    return false
  if (value.blockedAuditTurns != null && typeof value.blockedAuditTurns !== "number") return false
  if (typeof value.autoTurns !== "number") return false
  if (value.lastContinuationAt != null && typeof value.lastContinuationAt !== "number") return false
  if (value.remainingTokens !== null && typeof value.remainingTokens !== "number") return false
  if (value.sampledAt != null && typeof value.sampledAt !== "number") return false
  return true
}

function parseGoalToolOutput(part: GoalToolPart): GoalSnapshot | null | undefined {
  if (part.type !== "tool") return undefined
  if (
    !["get_goal", "create_goal", "update_goal"].includes(part.tool ?? "")
  )
    return undefined
  if (part.state?.status !== "completed") return undefined
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
  if (goal.blockedAuditTurns != null) lines.push(`Blocked-audit turns: ${goal.blockedAuditTurns}/3`)
  if (goal.lastPromptAgent) lines.push(`Pinned agent: ${goal.lastPromptAgent}`)
  if (goal.lastPromptModel) lines.push(`Pinned model: ${goal.lastPromptModel.providerID}/${goal.lastPromptModel.modelID}`)
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
  if (goal.status === "complete" || goal.status === "blocked") {
    const elapsed = liveTimeUsedSeconds(goal)
    return text({ fg: goal.status === "complete" ? theme.primary : theme.textMuted }, [
      `${goal.status === "complete" ? "Goal achieved" : "Goal blocked"} (${formatDurationBadge(elapsed)})`,
    ])
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

const plugin: TuiPluginModule = {
  id: "slash-goal-for-opencode.tui",
  tui,
}

export default plugin
