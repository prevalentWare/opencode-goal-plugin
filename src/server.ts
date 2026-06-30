import type { Config, Plugin } from "@opencode-ai/plugin"
import { z } from "zod"
import {
  accountUsage,
  clearGoal,
  completeGoal,
  createGoal,
  estimateTokensFromText,
  formatGoalHistory,
  getGoal,
  markGoalUnmet,
  pauseGoalForPlanMode,
  recordAssistantProgress,
  recordContinuationResult,
  recordPromptAgent,
  reserveContinuation,
  setGoalStatus,
  updateGoalObjective,
} from "./state"
import { compactionContext, continuationPrompt, limitPrompt, systemReminder } from "./prompts"

type Options = {
  auto_continue?: boolean
  defer_while_tasks_active?: boolean
  max_auto_turns?: number
  min_continue_interval_seconds?: number
  max_prompt_failures?: number
  register_command?: boolean
  command_name?: string
  default_token_budget?: number
  max_goal_duration_seconds?: number
  no_progress_token_threshold?: number
  max_no_progress_turns?: number
  restricted_agents?: string[]
  allow_goal_execution_from_plan?: boolean
}

type CreateGoalArgs = {
  objective: string
  token_budget?: number | null
  max_auto_turns?: number | null
  max_duration_seconds?: number | null
}

type UpdateGoalArgs =
  | {
      status: "complete"
      evidence?: string
      blocker?: string
    }
  | {
      status: "unmet"
      evidence?: string
      blocker?: string
    }

const DEFAULT_MAX_AUTO_TURNS = 25
const DEFAULT_CONTINUE_INTERVAL_SECONDS = 3
const DEFAULT_MAX_PROMPT_FAILURES = 3
const DEFAULT_COMMAND_NAME = "goal"
const DEFAULT_RESTRICTED_AGENTS = ["plan"]
const GOAL_SYSTEM_MARKER = "OpenCode goal mode"
const TASK_SETTLE_DELAY_MS = 25
const SNAPSHOT_IDLE_HOLD_MS = 250
const TASK_TERMINAL_STATES = new Set<TaskState>(["completed", "error", "cancelled"])
const PLAN_MODE_CREATE_NOTICE =
  'Goal recorded while the session is in Plan mode, so execution is paused. Do not start implementation work now. Ask the user to switch to Build mode and resume the goal (for example with "/goal resume") to begin execution.'
const activeContinuations = new Set<string>()

type TaskState = "running" | "completed" | "error" | "cancelled"

type TaskStatus = {
  taskID: string
  state: TaskState
}

type AssistantMarker = {
  id: string | null
  completedAt: number | null
}

type TaskRecord = {
  taskID: string
  parentSessionID: string
  state: TaskState
  terminalUnreconciled: boolean
  terminalAt: number | null
  lastAssistantMessageIDAtTerminal: string | null
}

type SnapshotIdleHold = {
  taskID: string
  parentSessionID: string
  expiresAt: number
}

function restrictedAgentSet(options?: Options) {
  if (options?.allow_goal_execution_from_plan === true) return new Set<string>()
  const names = Array.isArray(options?.restricted_agents) ? options.restricted_agents : DEFAULT_RESTRICTED_AGENTS
  return new Set(names.map((name) => (typeof name === "string" ? name.trim().toLowerCase() : "")).filter(Boolean))
}

function goalCommandTemplate(commandName: string) {
  return `OpenCode goal mode command "/${commandName}" was invoked.

Arguments:
<goal_command_arguments>
$ARGUMENTS
</goal_command_arguments>

Use the goal tools to handle this command:

- If the arguments are empty, call get_goal and briefly report the current goal state.
- If the arguments are "status", "show", or "current", call get_goal and briefly report the current goal state.
- If the arguments are "history", call get_goal_history and briefly report the current goal history.
- If the arguments are "clear", "stop", "off", "reset", "none", or "cancel", call clear_goal and report whether a goal was cleared.
- If the arguments are "pause", pause the current goal by calling update_goal_status with status "paused" and report the result.
- If the arguments are "resume", resume the current goal by calling update_goal_status with status "active" and continue working toward it.
- If the arguments start with "edit ", update the current goal objective by calling update_goal_objective with the remaining text.
- If the arguments start with "complete " or "done ", perform a completion audit against real artifacts and command output. Call update_goal with status "complete" only if the goal is achieved, using concise evidence from the audit.
- If the arguments start with "unmet ", "blocked ", or "blocker ", call update_goal with status "unmet" only when the goal cannot be achieved or needs external input, using the remaining arguments as the blocker.
- Otherwise, create a new goal with create_goal. Use the full arguments as the objective. If the user includes explicit budget instructions, pass token_budget, max_auto_turns, or max_duration_seconds to create_goal rather than leaving those words in the objective.

Create a goal only from these explicit command arguments. Do not infer a goal from unrelated session context. After create_goal succeeds, continue working toward the new goal.`
}

function commandNameFromOptions(options?: Options) {
  const name = options?.command_name?.trim() || DEFAULT_COMMAND_NAME
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return DEFAULT_COMMAND_NAME
  return name
}

function positiveIntegerOrNull(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null
}

function registerDesktopCommand(config: Config, commandName: string) {
  config.command ??= {}
  if (config.command[commandName]) return
  config.command[commandName] = {
    description: "Set or view the long-running session goal",
    template: goalCommandTemplate(commandName),
  }
}

function textFromPart(part: unknown): string {
  if (!part || typeof part !== "object") return ""
  const value = part as Record<string, unknown>
  if (value.type === "text" && typeof value.text === "string") return value.text
  if (typeof value.content === "string") return value.content
  return ""
}

function textFromMessage(message: { parts?: unknown[] }) {
  return (message.parts ?? []).map(textFromPart).filter(Boolean).join("\n").trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function sessionIDFromMessage(message: { info?: unknown; sessionID?: unknown }) {
  if (typeof message.sessionID === "string") return message.sessionID
  if (isRecord(message.info) && typeof message.info.sessionID === "string") return message.info.sessionID
  return undefined
}

function estimateMessages(messages: { parts?: unknown[] }[]) {
  return messages.reduce<number>((sum, message) => sum + estimateTokensFromText(textFromMessage(message)), 0)
}

function tokensFromRecord(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined
  const tokens = value as Record<string, unknown>
  if (typeof tokens.total === "number") return tokens.total
  const cache = tokens.cache && typeof tokens.cache === "object" ? (tokens.cache as Record<string, unknown>) : {}
  const fields = [tokens.input, tokens.output, tokens.reasoning, cache.read, cache.write]
  if (!fields.some((field) => typeof field === "number")) return undefined
  return fields.reduce<number>((sum, field) => sum + (typeof field === "number" && Number.isFinite(field) ? field : 0), 0)
}

function outputTokensFromRecord(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined
  const output = (value as Record<string, unknown>).output
  return typeof output === "number" && Number.isFinite(output) ? output : undefined
}

function exactTokensFromPart(part: unknown): number | undefined {
  if (!part || typeof part !== "object") return undefined
  const value = part as Record<string, unknown>
  if (value.type !== "step-finish") return undefined
  return tokensFromRecord(value.tokens)
}

function exactTokensFromMessage(message: { info?: unknown; parts?: unknown[] }) {
  const partTotal = (message.parts ?? []).reduce<number>((sum, part) => sum + (exactTokensFromPart(part) ?? 0), 0)
  if (partTotal > 0) return partTotal
  if (message.info && typeof message.info === "object") return tokensFromRecord((message.info as Record<string, unknown>).tokens)
  return undefined
}

function outputTokensFromMessage(message: { info?: unknown; parts?: unknown[] }) {
  let total: number | undefined
  for (const part of message.parts ?? []) {
    if (part && typeof part === "object" && (part as Record<string, unknown>).type === "step-finish") {
      const output = outputTokensFromRecord((part as Record<string, unknown>).tokens)
      if (output != null) total = (total ?? 0) + output
    }
  }
  if (total != null) return total
  if (message.info && typeof message.info === "object") return outputTokensFromRecord((message.info as Record<string, unknown>).tokens)
  return undefined
}

function tokensFromMessages(messages: { info?: unknown; parts?: unknown[] }[]) {
  const exactTotal = messages.reduce<number>((sum, message) => sum + (exactTokensFromMessage(message) ?? 0), 0)
  return exactTotal > 0 ? exactTotal : estimateMessages(messages)
}

function taskHeader(output: string) {
  const resultIndex = output.search(/<task_(?:result|error)>/)
  return resultIndex === -1 ? output : output.slice(0, resultIndex)
}

function parseTaskID(output: string) {
  const xmlMatch = /<task\s+[^>]*\bid=["']([^"']+)["'][^>]*>/i.exec(output)
  if (xmlMatch?.[1]) return xmlMatch[1]
  for (const line of output.split(/\r?\n/)) {
    const match = /^task_id:\s*([^\s()]+)(?:\s*\(.*)?$/i.exec(line.trim())
    if (match?.[1]) return match[1]
  }
  return undefined
}

function parseTaskState(output: string): TaskState | undefined {
  const xmlMatch = /<task\s+[^>]*\bstate=["'](running|completed|error|cancelled)["'][^>]*>/i.exec(output)
  if (xmlMatch?.[1]) return xmlMatch[1].toLowerCase() as TaskState
  for (const line of taskHeader(output).split(/\r?\n/)) {
    const match = /^state:\s*(running|completed|error|cancelled)\s*$/i.exec(line.trim())
    if (match?.[1]) return match[1].toLowerCase() as TaskState
  }
  return undefined
}

function parseTaskStatus(output: unknown): TaskStatus | undefined {
  if (typeof output !== "string") return undefined
  const taskID = parseTaskID(output)
  const state = parseTaskState(output)
  return taskID && state ? { taskID, state } : undefined
}

function messageCompletedAt(message: { info?: unknown; time?: unknown }) {
  const time =
    isRecord(message.time) ? message.time : isRecord(message.info) && isRecord(message.info.time) ? message.info.time : undefined
  const completed = time?.completed
  return typeof completed === "number" && Number.isFinite(completed) ? completed : null
}

function assistantMarker(message: { info?: unknown; role?: unknown; id?: unknown; time?: unknown }): AssistantMarker | undefined {
  if (messageRole(message) !== "assistant") return undefined
  return {
    id: messageID(message) ?? null,
    completedAt: messageCompletedAt(message),
  }
}

function agentFromMessage(message: { info?: unknown } | undefined) {
  if (!message) return undefined
  for (const source of [message, message.info]) {
    if (!isRecord(source)) continue
    for (const key of ["agent", "mode"]) {
      const value = source[key]
      if (typeof value === "string" && value.trim()) return value.trim()
    }
  }
  return undefined
}

async function sendContinuation(client: Parameters<Plugin>[0]["client"], sessionID: string, prompt: string, agent?: string | null) {
  await client.session.promptAsync({
    path: { id: sessionID },
    body: {
      ...(agent ? { agent } : {}),
      parts: [{ type: "text", text: prompt }],
    },
  })
}

function isIdleEvent(event: { type?: string; properties?: Record<string, unknown> }) {
  if (event.type === "session.idle") return true
  const status = event.properties?.status
  return event.type === "session.status" && typeof status === "object" && status !== null && (status as { type?: unknown }).type === "idle"
}

function sessionIDFromEvent(event: { properties?: Record<string, unknown> }) {
  const direct = event.properties?.sessionID
  if (typeof direct === "string") return direct
  const info = event.properties?.info
  if (typeof info === "object" && info !== null && typeof (info as { sessionID?: unknown }).sessionID === "string") {
    return (info as { sessionID: string }).sessionID
  }
  return undefined
}

function messageID(message: { info?: unknown; id?: unknown }) {
  if (typeof message.id === "string") return message.id
  if (message.info && typeof message.info === "object" && typeof (message.info as { id?: unknown }).id === "string") {
    return (message.info as { id: string }).id
  }
  return undefined
}

function messageRole(message: { info?: unknown; role?: unknown }) {
  if (typeof message.role === "string") return message.role
  if (message.info && typeof message.info === "object" && typeof (message.info as { role?: unknown }).role === "string") {
    return (message.info as { role: string }).role
  }
  return undefined
}

function latestAssistantMessage(messages: { info?: unknown; role?: unknown; id?: unknown; parts?: unknown[] }[]) {
  return [...messages].reverse().find((message) => messageRole(message) === "assistant")
}

async function fetchLatestAssistant(client: Parameters<Plugin>[0]["client"], sessionID: string) {
  const session = client.session as unknown as {
    messages?: (input: { path: { id: string }; query: { limit: number } }) => Promise<{ data?: unknown[] }>
  }
  if (!session.messages) return undefined
  const result = await session.messages({ path: { id: sessionID }, query: { limit: 20 } })
  const data = Array.isArray(result.data) ? result.data : []
  return latestAssistantMessage(data as { info?: unknown; role?: unknown; id?: unknown; parts?: unknown[] }[])
}

class TaskTracker {
  private readonly tasks = new Map<string, TaskRecord>()
  private readonly pendingTaskCalls = new Map<string, string>()
  private readonly latestAssistantBySession = new Map<string, AssistantMarker>()
  private readonly snapshotIdleHolds = new Map<string, SnapshotIdleHold>()
  private readonly settledSnapshotIdleTasks = new Set<string>()

  noteTaskCall(input: { tool?: unknown; sessionID?: unknown; callID?: unknown }) {
    if (typeof input.tool !== "string" || input.tool.toLowerCase() !== "task") return
    if (typeof input.sessionID !== "string") return
    if (typeof input.callID === "string") this.pendingTaskCalls.set(input.callID, input.sessionID)
  }

  noteTaskOutput(input: { tool?: unknown; sessionID?: unknown; callID?: unknown }, output: { output?: unknown }) {
    if (typeof input.tool !== "string" || input.tool.toLowerCase() !== "task") return
    const parentSessionID =
      typeof input.callID === "string" ? this.pendingTaskCalls.get(input.callID) ?? input.sessionID : input.sessionID
    if (typeof input.callID === "string") this.pendingTaskCalls.delete(input.callID)
    if (typeof parentSessionID !== "string") return
    const status = parseTaskStatus(output.output)
    if (!status) return
    if (status.state === "running") {
      this.markRunning(parentSessionID, status.taskID)
      return
    }
    this.markTerminal(status.taskID, status.state, parentSessionID, { resetReconciled: true })
  }

  observeSessionCreated(event: { properties?: Record<string, unknown> }) {
    const info = event.properties?.info
    if (!isRecord(info) || typeof info.id !== "string" || typeof info.parentID !== "string") return
    this.markRunning(info.parentID, info.id)
  }

  observeSessionStatus(sessionID: string, status: string) {
    const task = this.tasks.get(sessionID)
    if (!task) return
    if (status === "busy") {
      this.markRunning(task.parentSessionID, sessionID)
      return
    }
    if (status === "idle") this.markTerminal(sessionID, "completed", task.parentSessionID)
  }

  observeSessionDeleted(sessionID: string) {
    this.tasks.delete(sessionID)
    for (const task of this.tasks.values()) {
      if (task.parentSessionID === sessionID) this.tasks.delete(task.taskID)
    }
    this.latestAssistantBySession.delete(sessionID)
    this.clearSnapshotIdleForSession(sessionID)
  }

  observeMessages(messages: { info?: unknown; role?: unknown; id?: unknown; time?: unknown; parts?: unknown[] }[]) {
    for (const message of messages) {
      const sessionID = sessionIDFromMessage(message)
      if (!sessionID) continue
      const marker = assistantMarker(message)
      if (marker) {
        this.observeAssistant(sessionID, marker)
        continue
      }
      for (const part of message.parts ?? []) {
        const status = parseTaskStatus(textFromPart(part))
        if (!status) continue
        if (status.state === "running") this.markRunning(sessionID, status.taskID)
        else this.markTerminal(status.taskID, status.state, sessionID, { resetReconciled: true })
      }
    }
  }

  observeAssistantMessage(
    sessionID: string,
    message: { info?: unknown; role?: unknown; id?: unknown; time?: unknown } | undefined,
  ) {
    const marker = message ? assistantMarker(message) : undefined
    if (marker) this.observeAssistant(sessionID, marker)
  }

  hasBlockingTasks(parentSessionID: string) {
    this.pruneExpiredSnapshotIdleHolds()
    for (const task of this.tasks.values()) {
      if (task.parentSessionID !== parentSessionID) continue
      if (task.state === "running" || task.terminalUnreconciled) return true
    }
    for (const hold of this.snapshotIdleHolds.values()) {
      if (hold.parentSessionID === parentSessionID) return true
    }
    return false
  }

  nextSnapshotIdleRetryAt(parentSessionID: string) {
    this.pruneExpiredSnapshotIdleHolds()
    let next: number | null = null
    for (const hold of this.snapshotIdleHolds.values()) {
      if (hold.parentSessionID !== parentSessionID) continue
      next = next == null ? hold.expiresAt : Math.min(next, hold.expiresAt)
    }
    return next
  }

  async refreshLiveChildren(client: Parameters<Plugin>[0]["client"], parentSessionID: string) {
    const session = client.session as unknown as {
      children?: (input: { path: { id: string } }) => Promise<{ data?: unknown } | unknown[]>
      status?: () => Promise<{ data?: unknown } | Record<string, unknown>>
    }
    if (!session.children) return
    let childIDs: string[]
    try {
      const result = await session.children({ path: { id: parentSessionID } })
      const data = Array.isArray(result) ? result : Array.isArray(result.data) ? result.data : []
      childIDs = data.flatMap((child) => (isRecord(child) && typeof child.id === "string" ? [child.id] : []))
    } catch {
      return
    }
    this.markAbsentRunningChildren(parentSessionID, new Set(childIDs))
    if (childIDs.length === 0 || !session.status) return
    let statuses: Record<string, unknown>
    try {
      const result = await session.status()
      statuses = isRecord(result) && isRecord(result.data) ? result.data : isRecord(result) ? result : {}
    } catch {
      return
    }
    for (const childID of childIDs) {
      const status = statuses[childID]
      const statusType = isRecord(status) && typeof status.type === "string" ? status.type : undefined
      if (statusType === "busy") this.markRunning(parentSessionID, childID)
      else if (statusType === "idle") {
        if (this.tasks.has(childID)) this.markTerminal(childID, "completed", parentSessionID)
        else this.markSnapshotIdle(parentSessionID, childID)
      }
    }
  }

  private markRunning(parentSessionID: string, taskID: string) {
    const existing = this.tasks.get(taskID)
    this.clearSnapshotIdle(parentSessionID, taskID)
    this.tasks.set(taskID, {
      taskID,
      parentSessionID,
      state: "running",
      terminalUnreconciled: false,
      terminalAt: null,
      lastAssistantMessageIDAtTerminal: existing?.lastAssistantMessageIDAtTerminal ?? null,
    })
  }

  private markTerminal(
    taskID: string,
    state: TaskState,
    parentSessionID?: string,
    options: { resetReconciled?: boolean } = {},
  ) {
    if (!TASK_TERMINAL_STATES.has(state)) return
    const existing = this.tasks.get(taskID)
    const resolvedParentSessionID = existing?.parentSessionID ?? parentSessionID
    if (!resolvedParentSessionID) return
    this.clearSnapshotIdle(resolvedParentSessionID, taskID)
    if (
      existing &&
      TASK_TERMINAL_STATES.has(existing.state) &&
      !existing.terminalUnreconciled &&
      !options.resetReconciled
    ) {
      return
    }
    this.tasks.set(taskID, {
      taskID,
      parentSessionID: resolvedParentSessionID,
      state,
      terminalUnreconciled: true,
      terminalAt: Date.now(),
      lastAssistantMessageIDAtTerminal: this.latestAssistantBySession.get(resolvedParentSessionID)?.id ?? null,
    })
  }

  private markSnapshotIdle(parentSessionID: string, taskID: string) {
    const key = this.snapshotIdleKey(parentSessionID, taskID)
    if (this.settledSnapshotIdleTasks.has(key) || this.snapshotIdleHolds.has(key)) return
    this.snapshotIdleHolds.set(key, {
      taskID,
      parentSessionID,
      expiresAt: Date.now() + SNAPSHOT_IDLE_HOLD_MS,
    })
  }

  private clearSnapshotIdle(parentSessionID: string, taskID: string) {
    const key = this.snapshotIdleKey(parentSessionID, taskID)
    this.snapshotIdleHolds.delete(key)
    this.settledSnapshotIdleTasks.delete(key)
  }

  private clearSnapshotIdleForSession(sessionID: string) {
    for (const [key, hold] of this.snapshotIdleHolds) {
      if (hold.taskID === sessionID || hold.parentSessionID === sessionID) this.snapshotIdleHolds.delete(key)
    }
    for (const key of this.settledSnapshotIdleTasks) {
      if (key.startsWith(`${sessionID}\0`) || key.endsWith(`\0${sessionID}`)) {
        this.settledSnapshotIdleTasks.delete(key)
      }
    }
  }

  private pruneExpiredSnapshotIdleHolds(now = Date.now()) {
    for (const [key, hold] of this.snapshotIdleHolds) {
      if (hold.expiresAt > now) continue
      this.snapshotIdleHolds.delete(key)
      this.settledSnapshotIdleTasks.add(key)
      const task = this.tasks.get(hold.taskID)
      if (task?.parentSessionID === hold.parentSessionID && task.state === "running") this.tasks.delete(hold.taskID)
    }
  }

  private markAbsentRunningChildren(parentSessionID: string, liveChildIDs: Set<string>) {
    for (const task of this.tasks.values()) {
      if (task.parentSessionID !== parentSessionID || task.state !== "running" || liveChildIDs.has(task.taskID)) continue
      this.markSnapshotIdle(parentSessionID, task.taskID)
    }
  }

  private snapshotIdleKey(parentSessionID: string, taskID: string) {
    return `${parentSessionID}\0${taskID}`
  }

  private observeAssistant(sessionID: string, marker: AssistantMarker) {
    this.latestAssistantBySession.set(sessionID, marker)
    for (const task of this.tasks.values()) {
      if (task.parentSessionID !== sessionID || !task.terminalUnreconciled) continue
      if (this.assistantReconcilesTask(task, marker)) {
        this.tasks.set(task.taskID, { ...task, terminalUnreconciled: false })
      }
    }
  }

  private assistantReconcilesTask(task: TaskRecord, marker: AssistantMarker) {
    if (marker.id && task.lastAssistantMessageIDAtTerminal && marker.id !== task.lastAssistantMessageIDAtTerminal) return true
    if (marker.completedAt != null && task.terminalAt != null && marker.completedAt >= task.terminalAt) return true
    return false
  }
}

async function recordAssistantMessage(
  sessionID: string,
  message: { info?: unknown; role?: unknown; id?: unknown; parts?: unknown[] } | undefined,
  options: Options,
  evaluateContinuation = false,
) {
  if (!message) return
  await recordAssistantProgress(sessionID, {
    messageID: messageID(message),
    text: textFromMessage(message),
    outputTokens: outputTokensFromMessage(message) ?? null,
    noProgressTokenThreshold: positiveIntegerOrNull(options.no_progress_token_threshold),
    maxNoProgressTurns: positiveIntegerOrNull(options.max_no_progress_turns),
    evaluateContinuation,
  })
}

function mergeSystemReminder(output: { system: string[] }, reminder: string) {
  if (!reminder.trim()) return
  if (output.system.some((block) => block.includes(GOAL_SYSTEM_MARKER))) return
  if (output.system.length === 0) {
    output.system.push(reminder)
    return
  }
  output.system[0] = `${output.system[0]}\n\n${reminder}`
}

const server: Plugin = async ({ client }, options?: Options) => {
  const autoContinue = options?.auto_continue ?? true
  const deferWhileTasksActive = options?.defer_while_tasks_active ?? true
  const maxAutoTurns = positiveIntegerOrNull(options?.max_auto_turns) ?? DEFAULT_MAX_AUTO_TURNS
  const minInterval = positiveIntegerOrNull(options?.min_continue_interval_seconds) ?? DEFAULT_CONTINUE_INTERVAL_SECONDS
  const maxPromptFailures = positiveIntegerOrNull(options?.max_prompt_failures) ?? DEFAULT_MAX_PROMPT_FAILURES
  const registerCommand = options?.register_command ?? true
  const commandName = commandNameFromOptions(options)
  const taskTracker = new TaskTracker()
  const taskDeferredSessions = new Set<string>()
  const scheduledContinuations = new Map<string, ReturnType<typeof setTimeout>>()
  const busySessions = new Set<string>()
  const planAgents = restrictedAgentSet(options)
  const isPlanAgent = (agent: unknown) => typeof agent === "string" && planAgents.has(agent.trim().toLowerCase())

  async function createGoalFromTool(input: CreateGoalArgs, context: { sessionID: string; agent?: string }) {
    const planningOnly = isPlanAgent(context.agent)
    const goal = await createGoal(context.sessionID, input.objective, {
      tokenBudget: input.token_budget ?? options?.default_token_budget ?? null,
      maxAutoTurns: input.max_auto_turns ?? null,
      maxDurationSeconds: input.max_duration_seconds ?? options?.max_goal_duration_seconds ?? null,
      noProgressTokenThreshold: options?.no_progress_token_threshold ?? null,
      maxNoProgressTurns: options?.max_no_progress_turns ?? null,
      agent: typeof context.agent === "string" ? context.agent : null,
      initialStatus: planningOnly ? "paused" : "active",
    })
    return JSON.stringify(planningOnly ? { goal, plan_mode_notice: PLAN_MODE_CREATE_NOTICE } : { goal }, null, 2)
  }

  async function taskBlockStatus(sessionID: string) {
    if (!deferWhileTasksActive) return false
    await taskTracker.refreshLiveChildren(client, sessionID)
    return {
      blocked: taskTracker.hasBlockingTasks(sessionID),
      retryAt: taskTracker.nextSnapshotIdleRetryAt(sessionID),
    }
  }

  function scheduleSettledContinuation(sessionID: string, delayMs = TASK_SETTLE_DELAY_MS) {
    if (scheduledContinuations.has(sessionID)) return
    const timer = setTimeout(() => {
      scheduledContinuations.delete(sessionID)
      void runAutoContinue(sessionID, true)
    }, Math.max(0, delayMs))
    const maybeUnref = timer as { unref?: () => void }
    if (typeof maybeUnref.unref === "function") maybeUnref.unref()
    scheduledContinuations.set(sessionID, timer)
  }

  async function runAutoContinue(sessionID: string, fromTaskDeferral = false) {
    if (busySessions.has(sessionID)) return
    if (activeContinuations.has(sessionID)) return
    activeContinuations.add(sessionID)
    try {
      const latestAssistant = await fetchLatestAssistant(client, sessionID)
      taskTracker.observeAssistantMessage(sessionID, latestAssistant)
      const taskStatus = await taskBlockStatus(sessionID)
      if (taskStatus && taskStatus.blocked) {
        taskDeferredSessions.add(sessionID)
        if (taskStatus.retryAt != null) scheduleSettledContinuation(sessionID, taskStatus.retryAt - Date.now())
        return
      }
      if (busySessions.has(sessionID)) return
      await recordAssistantMessage(sessionID, latestAssistant, options ?? {}, true)
      const current = await getGoal(sessionID)
      if (!current) return
      const latestTurnAgent = agentFromMessage(latestAssistant)
      if (isPlanAgent(current.lastPromptAgent) || isPlanAgent(latestTurnAgent)) {
        if (current.status === "active") await pauseGoalForPlanMode(sessionID)
        return
      }
      if (busySessions.has(sessionID)) return
      if (!fromTaskDeferral && taskDeferredSessions.has(sessionID)) {
        scheduleSettledContinuation(sessionID)
        return
      }
      taskDeferredSessions.delete(sessionID)
      const goal = await reserveContinuation(sessionID, maxAutoTurns, minInterval)
      if (!goal) return
      await sendContinuation(
        client,
        sessionID,
        goal.status === "active" ? continuationPrompt(goal) : limitPrompt(goal),
        goal.lastPromptAgent ?? latestTurnAgent ?? null,
      )
      await recordContinuationResult(sessionID, "success", maxPromptFailures)
    } catch (error) {
      await recordContinuationResult(sessionID, "failure", maxPromptFailures)
      await client.app?.log?.({
        body: {
          service: "opencode-goal-plugin",
          level: "error",
          message: "Auto-continue failed",
          extra: { error: error instanceof Error ? error.message : String(error) },
        },
      })
    } finally {
      activeContinuations.delete(sessionID)
    }
  }

  return {
    async dispose() {
      for (const timer of scheduledContinuations.values()) clearTimeout(timer)
      scheduledContinuations.clear()
    },
    async config(config) {
      if (!registerCommand) return
      registerDesktopCommand(config, commandName)
    },
    tool: {
      get_goal: {
        description:
          "Get the current goal for this OpenCode session, including status, observed token usage, elapsed-time usage, budgets, checkpoints, and history.",
        args: {},
        async execute(_args, context) {
          return JSON.stringify({ goal: await getGoal(context.sessionID) }, null, 2)
        },
      },
      get_goal_history: {
        description: "Get the current goal lifecycle history and recent checkpoints for this OpenCode session.",
        args: {},
        async execute(_args, context) {
          const goal = await getGoal(context.sessionID)
          return JSON.stringify({ goal, history_report: formatGoalHistory(goal) }, null, 2)
        },
      },
      create_goal: {
        description:
          "Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks. Fails if a non-complete goal exists. While the session is in Plan mode, the goal is recorded as paused and execution requires the user to switch to Build mode.",
        args: {
          objective: z.string().min(1).max(4000).describe("The concrete objective to start pursuing."),
          token_budget: z.number().int().positive().nullable().optional().describe("Optional positive token budget."),
          max_auto_turns: z.number().int().positive().nullable().optional().describe("Optional per-goal auto-continue limit."),
          max_duration_seconds: z.number().int().positive().nullable().optional().describe("Optional per-goal duration limit."),
        },
        async execute(args, context) {
          return createGoalFromTool(args as CreateGoalArgs, context)
        },
      },
      set_goal: {
        description:
          "Set a new goal when the user explicitly asks the agent to formulate and set its own goal. The model should write the objective itself based on the user's explicit request. Fails if a non-complete goal exists. While the session is in Plan mode, the goal is recorded as paused and execution requires the user to switch to Build mode.",
        args: {
          objective: z.string().min(1).max(4000).describe("The model-formulated concrete objective to start pursuing."),
          token_budget: z.number().int().positive().nullable().optional().describe("Optional positive token budget."),
          max_auto_turns: z.number().int().positive().nullable().optional().describe("Optional per-goal auto-continue limit."),
          max_duration_seconds: z.number().int().positive().nullable().optional().describe("Optional per-goal duration limit."),
        },
        async execute(args, context) {
          return createGoalFromTool(args as CreateGoalArgs, context)
        },
      },
      update_goal_objective: {
        description: "Edit the current OpenCode goal objective when the user explicitly asks to edit or replace it.",
        args: {
          objective: z.string().min(1).max(4000).describe("The updated concrete objective."),
          status: z.enum(["active", "paused"]).optional().describe("Whether the edited goal should be active or paused."),
        },
        async execute(args, context) {
          const input = args as { objective: string; status?: "active" | "paused" }
          const requested = input.status ?? "active"
          const planningOnly = requested === "active" && isPlanAgent(context.agent)
          const goal = await updateGoalObjective(context.sessionID, input.objective, planningOnly ? "paused" : requested, {
            agent: typeof context.agent === "string" ? context.agent : null,
            planModePause: planningOnly,
          })
          return JSON.stringify(planningOnly ? { goal, plan_mode_notice: PLAN_MODE_CREATE_NOTICE } : { goal }, null, 2)
        },
      },
      update_goal: {
        description:
          "Close the existing goal only after an audit against real evidence. Use status complete only when the objective is achieved and no required work remains, and include evidence. Use status unmet only when the objective cannot be achieved or is blocked, and include the blocker. Do not close a goal merely because work is stopping.",
        args: {
          status: z.enum(["complete", "unmet"]).describe("Required. complete means achieved; unmet means blocked or impossible."),
          evidence: z
            .string()
            .min(1)
            .max(4000)
            .optional()
            .describe("Required when status is complete. Summarize the concrete evidence verified."),
          blocker: z
            .string()
            .min(1)
            .max(4000)
            .optional()
            .describe("Required when status is unmet. Explain the concrete blocker or impossibility."),
        },
        async execute(args, context) {
          const input = args as UpdateGoalArgs
          if (input.status === "complete") {
            const goal = await completeGoal(context.sessionID, input.evidence ?? "")
            const budget = goal.tokenBudget == null ? "" : ` Token usage: ${goal.tokensUsed}/${goal.tokenBudget}.`
            const report = `Goal achieved. Time used: ${goal.timeUsedSeconds} seconds.${budget} Evidence: ${goal.completionEvidence}.`
            return JSON.stringify({ goal, completion_report: report }, null, 2)
          }
          const goal = await markGoalUnmet(context.sessionID, input.blocker ?? "")
          const report = `Goal unmet. Time used: ${goal.timeUsedSeconds} seconds. Blocker: ${goal.blocker}.`
          return JSON.stringify({ goal, unmet_report: report }, null, 2)
        },
      },
      update_goal_status: {
        description:
          "Pause or resume the current OpenCode goal when the user explicitly asks to pause or resume it. Resuming is not allowed while the session is in Plan mode; the user must switch to Build mode first.",
        args: {
          status: z.enum(["active", "paused"]).describe("active resumes a goal; paused pauses it without clearing it."),
        },
        async execute(args, context) {
          const input = args as { status: "active" | "paused" }
          if (input.status === "active" && isPlanAgent(context.agent)) {
            throw new Error(
              "cannot resume the goal while the session is in Plan mode; ask the user to switch to Build mode and resume the goal from there",
            )
          }
          const goal = await setGoalStatus(context.sessionID, input.status, typeof context.agent === "string" ? context.agent : null)
          return JSON.stringify({ goal }, null, 2)
        },
      },
      clear_goal: {
        description: "Clear the current OpenCode goal for this session when the user explicitly asks to clear it.",
        args: {},
        async execute(_args, context) {
          return JSON.stringify({ cleared: await clearGoal(context.sessionID) }, null, 2)
        },
      },
    },
    async "tool.execute.before"(input) {
      taskTracker.noteTaskCall(input as { tool?: unknown; sessionID?: unknown; callID?: unknown })
    },
    async "tool.execute.after"(input, output) {
      taskTracker.noteTaskOutput(
        input as { tool?: unknown; sessionID?: unknown; callID?: unknown },
        output as { output?: unknown },
      )
    },
    async "chat.message"(input, output) {
      const sessionID = typeof input?.sessionID === "string" ? input.sessionID : output.message?.sessionID
      const agent = typeof input?.agent === "string" && input.agent.trim() ? input.agent : output.message?.agent
      if (typeof sessionID !== "string" || typeof agent !== "string" || !agent.trim()) return
      await recordPromptAgent(sessionID, agent)
    },
    async "experimental.chat.messages.transform"(input, output) {
      taskTracker.observeMessages(output.messages)
      const sessionID =
        "sessionID" in input && typeof input.sessionID === "string"
          ? input.sessionID
          : output.messages.find((message) => typeof message.info.sessionID === "string")?.info.sessionID
      if (!sessionID) return
      await accountUsage(sessionID, tokensFromMessages(output.messages))
      await recordAssistantMessage(sessionID, latestAssistantMessage(output.messages), options ?? {})
    },
    async "experimental.chat.system.transform"(input, output) {
      if (typeof input.sessionID !== "string") return
      const goal = await getGoal(input.sessionID)
      mergeSystemReminder(output, systemReminder(goal, { planningOnly: isPlanAgent(goal?.lastPromptAgent) }))
    },
    async "experimental.session.compacting"(input, output) {
      const goal = await getGoal(input.sessionID)
      if (!goal) return
      output.context.push(compactionContext(goal))
    },
    async "experimental.compaction.autocontinue"(input, output) {
      const goal = await getGoal(input.sessionID)
      if (goal?.status === "active") output.enabled = false
    },
    async event({ event }) {
      const sessionID = sessionIDFromEvent(event as never)
      const eventType = (event as { type?: string }).type
      if (eventType === "session.created") {
        taskTracker.observeSessionCreated(event as { properties?: Record<string, unknown> })
      }
      if (sessionID && eventType === "session.status") {
        const status = (event as { properties?: Record<string, unknown> }).properties?.status
        if (isRecord(status) && typeof status.type === "string") {
          if (status.type === "busy") busySessions.add(sessionID)
          if (status.type === "idle") busySessions.delete(sessionID)
          taskTracker.observeSessionStatus(sessionID, status.type)
        }
      }
      if (sessionID && eventType === "session.idle") {
        busySessions.delete(sessionID)
        taskTracker.observeSessionStatus(sessionID, "idle")
      }
      if (sessionID && eventType === "session.deleted") {
        busySessions.delete(sessionID)
        taskTracker.observeSessionDeleted(sessionID)
      }
      if (sessionID && (event as { type?: string }).type === "message.updated") {
        const props = (event as { properties?: Record<string, unknown> }).properties ?? {}
        const message = [props.info, props.message].find((value) => value && typeof value === "object") as
          | { info?: unknown; role?: unknown; id?: unknown; time?: unknown; parts?: unknown[] }
          | undefined
        taskTracker.observeAssistantMessage(sessionID, message)
        await recordAssistantMessage(sessionID, message, options ?? {})
      }

      if (!autoContinue || !isIdleEvent(event as never)) return
      if (!sessionID) return
      await runAutoContinue(sessionID)
    },
  }
}

export default {
  id: "local.goal-mode.server",
  server,
}
