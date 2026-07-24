import type { Config, Plugin } from "@opencode-ai/plugin"
import { z } from "zod"
import {
  accountMessageUsage,
  cancelContinuationReservation,
  clearGoal,
  completeGoal,
  createGoal,
  estimateTokensFromText,
  formatGoal,
  getGoal,
  markGoalBlocked,
  pauseGoalForPlanMode,
  pauseGoalForUserInterrupt,
  recordAssistantProgress,
  recordContinuationPromptRuntime,
  recordContinuationResult,
  recordPromptRuntime,
  reserveContinuation,
  setGoalStatus,
  stopGoalForRuntimeError,
  updateGoalObjective,
} from "./state"
import type { ContinuationReservation, GoalModel, GoalSnapshot, MessageUsageAccuracy } from "./state"
import { compactionContext, continuationPrompt, limitPrompt, objectiveUpdatedPrompt, systemReminder } from "./prompts"

type Options = {
  auto_continue?: boolean
  defer_while_tasks_active?: boolean
  max_auto_turns?: number
  min_continue_interval_seconds?: number
  max_turn_time?: number
  max_prompt_failures?: number
  register_command?: boolean
  command_name?: string
  max_goal_duration_seconds?: number
  no_progress_token_threshold?: number
  max_no_progress_turns?: number
  restricted_agents?: string[]
  allow_goal_execution_from_plan?: boolean
}

type CreateGoalArgs = {
  objective: string
  token_budget?: number | null
}

type UpdateGoalArgs = { status: "complete" | "blocked" }

// Native Codex has no arbitrary per-goal continuation count cap. Zero means
// unbounded here; users may still opt into max_auto_turns explicitly.
const DEFAULT_MAX_AUTO_TURNS = 0
const DEFAULT_CONTINUE_INTERVAL_SECONDS = 3
const DEFAULT_MAX_PROMPT_FAILURES = 3
const DEFAULT_COMMAND_NAME = "goal"
const DEFAULT_RESTRICTED_AGENTS = ["plan"]
const GOAL_SYSTEM_MARKER = "OpenCode goal mode"
const TASK_SETTLE_DELAY_MS = 25
const SNAPSHOT_IDLE_HOLD_MS = 250
const MAX_TIMER_DELAY_MS = 2_147_483_647
const TASK_TERMINAL_STATES = new Set<TaskState>(["completed", "error", "cancelled"])
const PLAN_MODE_CREATE_NOTICE =
  'Goal recorded while the session is in Plan mode, so execution is paused. Do not start implementation work now. Ask the user to switch to Build mode and resume the goal (for example with "/goal resume") to begin execution.'
const activeContinuations = new Set<string>()
const GOAL_COMMAND_MARKER = "slash-goal-for-opencode-command"
const CONTINUATION_PROMPT_MARKER = "slash-goal-for-opencode-continuation"

type TaskState = "running" | "completed" | "error" | "cancelled"

type TaskStatus = {
  taskID: string
  state: TaskState
}

type AssistantMarker = {
  id: string | null
  completedAt: number | null
}

type ContinuationOutcomeAttempt = {
  reservation: ContinuationReservation
  baselineMessageID: string
  baselineSignature: string
}

type ContinuationFailureStreak = {
  failures: number
  pendingAttempt: ContinuationOutcomeAttempt | null
  errorObserved: boolean
  baselineMessageID: string
  baselineSignature: string
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

type TurnWatchdog = {
  timer: ReturnType<typeof setTimeout>
}

type ContinuationSource = "idle" | "watchdog"

type PendingContinuationPrompt = {
  prompt: string
  reservation: ContinuationReservation
  source: ContinuationSource
}

function restrictedAgentSet(options?: Options) {
  if (options?.allow_goal_execution_from_plan === true) return new Set<string>()
  const names = Array.isArray(options?.restricted_agents) ? options.restricted_agents : DEFAULT_RESTRICTED_AGENTS
  return new Set(names.map((name) => (typeof name === "string" ? name.trim().toLowerCase() : "")).filter(Boolean))
}

function goalCommandTemplate(commandName: string) {
  return `<${GOAL_COMMAND_MARKER} name="${commandName}">
$ARGUMENTS
</${GOAL_COMMAND_MARKER}>

This slash command is handled deterministically by the slash/goal for OpenCode plugin before the model turn. Do not infer a different goal action from surrounding chat context.`
}

function commandNameFromOptions(options?: Options) {
  const name = options?.command_name?.trim() || DEFAULT_COMMAND_NAME
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return DEFAULT_COMMAND_NAME
  return name
}

function positiveIntegerOrNull(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null
}

function timeoutMillisecondsFromSeconds(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null
  return Math.min(Math.ceil(value * 1000), MAX_TIMER_DELAY_MS)
}

function nonNegativeIntegerOrNull(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null
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

function goalTokensFromRecord(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined
  const tokens = value as Record<string, unknown>
  const input = typeof tokens.input === "number" && Number.isFinite(tokens.input) ? Math.max(0, tokens.input) : null
  const output = typeof tokens.output === "number" && Number.isFinite(tokens.output) ? Math.max(0, tokens.output) : null
  const reasoning =
    typeof tokens.reasoning === "number" && Number.isFinite(tokens.reasoning) ? Math.max(0, tokens.reasoning) : null
  // OpenCode reports cache reads/writes and reasoning separately. Native Codex
  // goal budgets charge uncached input + total output; OpenCode's total output
  // is its visible output plus its separately reported reasoning output.
  if (input != null || output != null || reasoning != null) return (input ?? 0) + (output ?? 0) + (reasoning ?? 0)
  // `total` is not a stable substitute for Codex goal-budget accounting: it
  // may include cache traffic or otherwise use provider-specific semantics.
  return undefined
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
  return goalTokensFromRecord(value.tokens)
}

function exactTokensFromMessage(message: { info?: unknown; parts?: unknown[] }) {
  let partTotal = 0
  let hasExactPartUsage = false
  for (const part of message.parts ?? []) {
    const exact = exactTokensFromPart(part)
    if (exact == null) continue
    hasExactPartUsage = true
    partTotal += exact
  }
  if (hasExactPartUsage) return partTotal
  if (message.info && typeof message.info === "object")
    return goalTokensFromRecord((message.info as Record<string, unknown>).tokens)
  return undefined
}

function goalUsageFromMessage(message: { info?: unknown; parts?: unknown[] }) {
  const exact = exactTokensFromMessage(message)
  return exact == null
    ? { tokens: estimateTokensFromText(textFromMessage(message)), accuracy: "estimated" as const }
    : { tokens: exact, accuracy: "exact" as const }
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

async function sendContinuation(
  client: Parameters<Plugin>[0]["client"],
  sessionID: string,
  prompt: string,
  agent?: string | null,
  model?: GoalModel | null,
) {
  await client.session.promptAsync({
    path: { id: sessionID },
    body: {
      ...(agent ? { agent } : {}),
      ...(model ? { model } : {}),
      parts: [{ type: "text", text: prompt }],
    },
  })
}

function sameContinuationReservation(
  current: ContinuationReservation | null | undefined,
  expected: ContinuationReservation | null | undefined,
) {
  return (
    current != null &&
    expected != null &&
    current.nonce === expected.nonce &&
    current.promptGeneration === expected.promptGeneration &&
    current.autoTurn === expected.autoTurn &&
    current.kind === expected.kind
  )
}

function continuationWirePrompt(prompt: string, reservation: ContinuationReservation) {
  return `${prompt}\n\n<${CONTINUATION_PROMPT_MARKER} nonce="${reservation.nonce}" />`
}

function acceptContinuationPrompt(
  parts: unknown[],
  pending: PendingContinuationPrompt | undefined,
) {
  if (!pending || textFromMessage({ parts }) !== pending.prompt) return false
  const marker = `\n\n<${CONTINUATION_PROMPT_MARKER} nonce="${pending.reservation.nonce}" />`
  for (const part of parts) {
    if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string" || !part.text.endsWith(marker)) continue
    part.text = part.text.slice(0, -marker.length)
    return true
  }
  return false
}

function goalToolResponse(goal: GoalSnapshot | null, completionBudgetReport: string | null = null) {
  return {
    goal,
    remainingTokens: goal?.remainingTokens ?? null,
    completionBudgetReport,
  }
}

function commandInvocation(parts: unknown[], commandName: string) {
  const open = `<${GOAL_COMMAND_MARKER} name="${commandName}">`
  const close = `</${GOAL_COMMAND_MARKER}>`
  for (const part of parts) {
    const text = textFromPart(part)
    const start = text.indexOf(open)
    const end = text.lastIndexOf(close)
    if (start >= 0 && end > start) return text.slice(start + open.length, end).trim()
  }
  return undefined
}

function replaceCommandMessage(parts: unknown[], text: string) {
  const textPart = parts.find((part) => isRecord(part) && part.type === "text")
  if (isRecord(textPart)) {
    textPart.text = text
    return
  }
  parts.push({ type: "text", text })
}

function normalizedModel(model: unknown): GoalModel | null {
  if (!isRecord(model) || typeof model.providerID !== "string" || typeof model.modelID !== "string") return null
  const providerID = model.providerID.trim()
  const modelID = model.modelID.trim()
  return providerID && modelID ? { providerID, modelID } : null
}

function isIdleEvent(event: { type?: string; properties?: Record<string, unknown> }) {
  if (event.type === "session.idle") return true
  const status = event.properties?.status
  return event.type === "session.status" && typeof status === "object" && status !== null && (status as { type?: unknown }).type === "idle"
}

function sessionIDFromEvent(event: { type?: string; properties?: Record<string, unknown> }) {
  const direct = event.properties?.sessionID
  if (typeof direct === "string") return direct
  const info = event.properties?.info
  if (typeof info === "object" && info !== null) {
    if (typeof (info as { sessionID?: unknown }).sessionID === "string") return (info as { sessionID: string }).sessionID
    if (event.type === "session.deleted" && typeof (info as { id?: unknown }).id === "string") {
      return (info as { id: string }).id
    }
  }
  if (
    event.type?.startsWith("session.") &&
    typeof info === "object" &&
    info !== null &&
    typeof (info as { id?: unknown }).id === "string"
  ) {
    return (info as { id: string }).id
  }
  return undefined
}

function runtimeErrorDetails(error: unknown) {
  const records: Record<string, unknown>[] = []
  const queue: { value: unknown; depth: number }[] = [{ value: error, depth: 0 }]
  const seen = new Set<object>()
  while (queue.length > 0 && records.length < 32) {
    const current = queue.shift()!
    if (!isRecord(current.value) || seen.has(current.value)) continue
    seen.add(current.value)
    records.push(current.value)
    if (current.depth >= 5) continue
    for (const value of Object.values(current.value)) {
      if (isRecord(value)) queue.push({ value, depth: current.depth + 1 })
    }
  }
  const stringField = (key: string) =>
    records.map((record) => record[key]).find((value): value is string => typeof value === "string" && value.trim() !== "")
  const name = stringField("name")
  const code = stringField("code")
  const message = stringField("message")
  const status = records
    .flatMap((record) => [record.statusCode, record.status])
    .find((value) => typeof value === "number" || typeof value === "string")
  const searchable = records
    .flatMap((record) => [record.name, record.code, record.type, record.message])
    .filter((value): value is string => typeof value === "string")
    .join(" ")
  const text = [name, code, message, status == null ? null : `status ${status}`].filter(Boolean).join(": ")
  return {
    name: typeof name === "string" ? name : "",
    code: typeof code === "string" ? code : "",
    message: typeof message === "string" ? message : "",
    status: typeof status === "number" ? status : typeof status === "string" ? Number.parseInt(status, 10) : null,
    searchable,
    text: text || "OpenCode reported a terminal goal turn error.",
  }
}

type RuntimeErrorDisposition = "interrupted" | "blocked" | "usageLimited" | "contextOverflow" | "transport"

function runtimeErrorDisposition(error: unknown): RuntimeErrorDisposition {
  const details = runtimeErrorDetails(error)
  const searchable = details.searchable.toLowerCase()
  if (/abort|cancel(?:led|ed)|interrupt/.test(searchable)) return "interrupted"
  if (/context[_ -]?length[_ -]?exceeded|maximum context length|too many tokens for (?:the )?context/.test(searchable)) {
    return "contextOverflow"
  }
  if (
    details.status === 429 ||
    /rate.?limit|usage.?limit|quota|too many requests|insufficient.?quota|credits? exhausted/.test(searchable)
  )
    return "usageLimited"
  if (
    details.status === 408 ||
    details.status === 502 ||
    details.status === 503 ||
    details.status === 504 ||
    /\b(?:econnrefused|econnreset|enetunreach|ehostunreach|etimedout|fetcherror|connecterror|connectionerror|providerheadertimeouterror|und_err_(?:connect|headers)_timeout)\b|fetch failed|network error|(?:unable|cannot) to connect|connection (?:was )?(?:refused|reset|closed|failed)|connection timed out|socket hang up|service unavailable|gateway timeout|(?:request|response headers) timed out|no response|empty response/.test(
      searchable,
    )
  ) {
    return "transport"
  }
  return "blocked"
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

function assistantProgressSignature(message: { info?: unknown; role?: unknown; parts?: unknown[] } | undefined) {
  if (!message || messageRole(message) !== "assistant") return ""
  const signatures: string[] = []
  for (const part of message.parts ?? []) {
    if (!isRecord(part)) continue
    const type = typeof part.type === "string" ? part.type.toLowerCase() : ""
    if (type.includes("tool")) {
      const state = isRecord(part.state) ? part.state : undefined
      const status = typeof state?.status === "string" ? state.status.trim().toLowerCase() : ""
      if (/error|fail|cancel|abort|interrupt|incomplete|pending|running/.test(status)) continue
      const substantiveOutput = [state?.output, state?.result, part.output, part.result].some((value) => {
        if (typeof value === "string") return value.trim().length > 0
        if (Array.isArray(value)) return value.length > 0
        if (isRecord(value)) return Object.keys(value).length > 0
        return value !== null && value !== undefined
      })
      if (/complete|success|succeed/.test(status) || substantiveOutput) {
        signatures.push(`${type}:${JSON.stringify(part)}`)
      }
      continue
    }
    const text = textFromPart(part).trim()
    if (text) {
      signatures.push(`${type || "text"}:${text}`)
      continue
    }
    if (type === "step-finish") {
      const reason = typeof part.reason === "string" ? part.reason.toLowerCase() : ""
      const output = outputTokensFromRecord(part.tokens)
      if (!/error|abort|cancel|interrupt/.test(reason) && ((output ?? 0) > 0 || /tool/.test(reason))) {
        signatures.push(`${type}:${JSON.stringify(part)}`)
      }
    }
  }
  return signatures.join("\n")
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

async function fetchMessageGoalTokens(
  client: Parameters<Plugin>[0]["client"],
  sessionID: string,
  currentMessageID?: string,
) {
  const fallback = { tokens: 0, accuracy: "estimated" as MessageUsageAccuracy }
  if (!currentMessageID) return fallback
  const session = client.session as unknown as {
    message?: (input: { path: { id: string; messageID: string } }) => Promise<{ data?: unknown }>
  }
  if (!session.message) return fallback
  try {
    const result = await session.message({ path: { id: sessionID, messageID: currentMessageID } })
    const message = isRecord(result.data) ? result.data : undefined
    if (!message) return fallback
    const exact = exactTokensFromMessage(message)
    return exact == null ? fallback : { tokens: exact, accuracy: "exact" as const }
  } catch {
    // Baseline lookup is best-effort. Per-message accounting remains
    // idempotent even when the current in-flight message cannot be fetched.
    return fallback
  }
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
  const id = messageID(message)
  if (id) {
    const usage = goalUsageFromMessage(message)
    await accountMessageUsage(sessionID, id, usage.tokens, usage.accuracy)
  }
  return recordAssistantProgress(sessionID, {
    messageID: id,
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
  const minInterval = nonNegativeIntegerOrNull(options?.min_continue_interval_seconds) ?? DEFAULT_CONTINUE_INTERVAL_SECONDS
  const maxTurnTimeMs = timeoutMillisecondsFromSeconds(options?.max_turn_time)
  const maxPromptFailures = positiveIntegerOrNull(options?.max_prompt_failures) ?? DEFAULT_MAX_PROMPT_FAILURES
  const registerCommand = options?.register_command ?? true
  const commandName = commandNameFromOptions(options)
  const taskTracker = new TaskTracker()
  const taskDeferredSessions = new Set<string>()
  const scheduledContinuations = new Map<string, ReturnType<typeof setTimeout>>()
  const turnWatchdogs = new Map<string, TurnWatchdog>()
  const watchdogRescuedSessions = new Set<string>()
  const busySessions = new Set<string>()
  const errorStoppedSessions = new Set<string>()
  const continuationFailureStreaks = new Map<string, ContinuationFailureStreak>()
  const handledIdleEpisodes = new Set<string>()
  const contextRecoverySessions = new Set<string>()
  const contextRecoveryEpisodes = new Map<
    string,
    { promptGeneration: number; autoTurns: number; assistantMessageID: string; assistantText: string }
  >()
  const lastPromptRuntime = new Map<string, { agent: string | null; model: GoalModel | null }>()
  const pendingGoalCommands = new Map<string, { arguments: string; expiresAt: number }>()
  const pendingContinuationPrompts = new Map<string, PendingContinuationPrompt>()
  const planAgents = restrictedAgentSet(options)
  const isPlanAgent = (agent: unknown) => typeof agent === "string" && planAgents.has(agent.trim().toLowerCase())

  function clearContinuationFailureStreak(sessionID: string) {
    continuationFailureStreaks.delete(sessionID)
    handledIdleEpisodes.delete(sessionID)
  }

  function goalWithContinuationFailureStreak(sessionID: string, goal: GoalSnapshot | null) {
    const failures = continuationFailureStreaks.get(sessionID)?.failures ?? 0
    if (!goal || failures <= goal.continuationFailures) return goal
    return { ...goal, continuationFailures: failures }
  }

  async function createGoalFromTool(
    input: CreateGoalArgs,
    context: { sessionID: string; messageID?: string; agent?: string },
  ) {
    const planningOnly = isPlanAgent(context.agent)
    const runtime = lastPromptRuntime.get(context.sessionID)
    const accountingMessageUsage = await fetchMessageGoalTokens(client, context.sessionID, context.messageID)
    const goal = await createGoal(context.sessionID, input.objective, {
      tokenBudget: input.token_budget ?? null,
      maxAutoTurns: positiveIntegerOrNull(options?.max_auto_turns),
      maxDurationSeconds: positiveIntegerOrNull(options?.max_goal_duration_seconds),
      noProgressTokenThreshold: options?.no_progress_token_threshold ?? null,
      maxNoProgressTurns: options?.max_no_progress_turns ?? null,
      agent: typeof context.agent === "string" ? context.agent : null,
      model: runtime?.model ?? null,
      accountingMessageID: context.messageID ?? null,
      accountingMessageTokens: accountingMessageUsage.tokens,
      accountingMessageAccuracy: accountingMessageUsage.accuracy,
      initialStatus: planningOnly ? "paused" : "active",
    })
    errorStoppedSessions.delete(context.sessionID)
    clearContinuationFailureStreak(context.sessionID)
    return JSON.stringify(
      planningOnly ? { ...goalToolResponse(goal), planModeNotice: PLAN_MODE_CREATE_NOTICE } : goalToolResponse(goal),
      null,
      2,
    )
  }

  async function handleGoalCommand(
    sessionID: string,
    rawArguments: string,
    runtime: { agent: string | null; model: GoalModel | null },
  ) {
    const args = rawArguments.trim()
    const normalized = args.toLowerCase()
    if (!args) {
      const goal = await getGoal(sessionID)
      return `The /${commandName} command read goal state. No mutation was performed.\n\n${formatGoal(goal)}`
    }

    if (normalized === "clear") {
      const cleared = await clearGoal(sessionID)
      errorStoppedSessions.delete(sessionID)
      clearContinuationFailureStreak(sessionID)
      return `The /${commandName} command ${cleared ? "cleared the current goal" : "found no goal to clear"}. This action was already applied; do not call a goal tool to repeat it.`
    }

    if (normalized === "pause") {
      const goal = await setGoalStatus(sessionID, "paused", runtime.agent)
      clearContinuationFailureStreak(sessionID)
      return `The /${commandName} command paused the goal. This user-controlled action was already applied; do not call update_goal.\n\n${formatGoal(goal)}`
    }

    if (normalized === "resume") {
      if (isPlanAgent(runtime.agent)) {
        return `The /${commandName} command did not resume the goal because the session is in Plan mode. Ask the user to switch to Build mode, then run /${commandName} resume.`
      }
      const goal = await setGoalStatus(sessionID, "active", runtime.agent)
      errorStoppedSessions.delete(sessionID)
      contextRecoveryEpisodes.delete(sessionID)
      clearContinuationFailureStreak(sessionID)
      return `The /${commandName} command resumed the goal. This user-controlled action was already applied; do not call update_goal to repeat it.\n\n${continuationPrompt(goal)}`
    }

    const edit = /^edit(?:\s+([\s\S]*))?$/i.exec(args)
    if (edit) {
      const objective = edit[1]?.trim() ?? ""
      if (!objective) return `/${commandName} edit requires the replacement objective: /${commandName} edit <objective>. No mutation was performed.`
      const planningOnly = isPlanAgent(runtime.agent)
      const goal = await updateGoalObjective(sessionID, objective, planningOnly ? "paused" : "active", {
        agent: runtime.agent,
        planModePause: planningOnly,
      })
      errorStoppedSessions.delete(sessionID)
      clearContinuationFailureStreak(sessionID)
      return `${planningOnly ? PLAN_MODE_CREATE_NOTICE : `The /${commandName} command updated and resumed the goal.`}\n\n${objectiveUpdatedPrompt(goal)}`
    }

    const planningOnly = isPlanAgent(runtime.agent)
    const goal = await createGoal(sessionID, args, {
      tokenBudget: null,
      maxAutoTurns: positiveIntegerOrNull(options?.max_auto_turns),
      maxDurationSeconds: positiveIntegerOrNull(options?.max_goal_duration_seconds),
      noProgressTokenThreshold: options?.no_progress_token_threshold ?? null,
      maxNoProgressTurns: options?.max_no_progress_turns ?? null,
      agent: runtime.agent,
      model: runtime.model,
      initialStatus: planningOnly ? "paused" : "active",
    })
    errorStoppedSessions.delete(sessionID)
    clearContinuationFailureStreak(sessionID)
    return planningOnly
      ? `${PLAN_MODE_CREATE_NOTICE}\n\n${formatGoal(goal)}`
      : `The /${commandName} command created the goal. This action was already applied; do not call create_goal to repeat it.\n\n${continuationPrompt(goal)}`
  }

  async function taskBlockStatus(sessionID: string) {
    if (!deferWhileTasksActive) return false
    await taskTracker.refreshLiveChildren(client, sessionID)
    return {
      blocked: taskTracker.hasBlockingTasks(sessionID),
      retryAt: taskTracker.nextSnapshotIdleRetryAt(sessionID),
    }
  }

  function clearTurnWatchdog(sessionID: string) {
    const watchdog = turnWatchdogs.get(sessionID)
    if (!watchdog) return
    clearTimeout(watchdog.timer)
    turnWatchdogs.delete(sessionID)
  }

  function clearWatchdogEpisode(sessionID: string) {
    clearTurnWatchdog(sessionID)
    watchdogRescuedSessions.delete(sessionID)
  }

  function armTurnWatchdog(sessionID: string) {
    if (maxTurnTimeMs == null || watchdogRescuedSessions.has(sessionID)) return
    clearTurnWatchdog(sessionID)
    const watchdog: TurnWatchdog = {
      timer: setTimeout(() => void runTurnWatchdog(sessionID, watchdog), maxTurnTimeMs),
    }
    const maybeUnref = watchdog.timer as { unref?: () => void }
    if (typeof maybeUnref.unref === "function") maybeUnref.unref()
    turnWatchdogs.set(sessionID, watchdog)
  }

  async function runTurnWatchdog(sessionID: string, watchdog: TurnWatchdog) {
    try {
      if (turnWatchdogs.get(sessionID) !== watchdog || !busySessions.has(sessionID)) return
      const goal = await getGoal(sessionID)
      if (turnWatchdogs.get(sessionID) !== watchdog || !busySessions.has(sessionID)) return
      if (goal?.status !== "active" || isPlanAgent(goal.lastPromptAgent)) return
      const latestAssistant = await fetchLatestAssistant(client, sessionID)
      if (turnWatchdogs.get(sessionID) !== watchdog || !busySessions.has(sessionID)) return
      const latestTurnAgent = agentFromMessage(latestAssistant)
      if (isPlanAgent(latestTurnAgent)) return
      const taskStatus = await taskBlockStatus(sessionID)
      if (turnWatchdogs.get(sessionID) !== watchdog || !busySessions.has(sessionID)) return
      if (taskStatus && taskStatus.blocked) return
      const current = await getGoal(sessionID)
      if (turnWatchdogs.get(sessionID) !== watchdog || !busySessions.has(sessionID)) return
      if (current?.status !== "active" || isPlanAgent(current.lastPromptAgent) || activeContinuations.has(sessionID)) return

      turnWatchdogs.delete(sessionID)
      watchdogRescuedSessions.add(sessionID)
      const streak = continuationFailureStreaks.get(sessionID)
      if (streak?.pendingAttempt) {
        if (hasSuccessfulAssistantProgress(streak, latestAssistant)) {
          clearContinuationFailureStreak(sessionID)
        } else {
          updateFailureBaseline(streak, latestAssistant)
          if (await failContinuationOutcomeAttempt(sessionID, streak.pendingAttempt.reservation, false)) return
        }
      } else if (streak?.errorObserved) {
        updateFailureBaseline(streak, latestAssistant)
        streak.errorObserved = false
      }
      if (!busySessions.has(sessionID)) return
      await runAutoContinue(sessionID, false, "watchdog")
    } catch (error) {
      try {
        await client.app?.log?.({
          body: {
            service: "slash-goal-for-opencode",
            level: "error",
            message: "Turn watchdog retry failed",
            extra: { error: error instanceof Error ? error.message : String(error) },
          },
        })
      } catch {
        return
      }
    } finally {
      if (turnWatchdogs.get(sessionID) === watchdog) turnWatchdogs.delete(sessionID)
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

  function cancelScheduledContinuation(sessionID: string) {
    const timer = scheduledContinuations.get(sessionID)
    if (timer) clearTimeout(timer)
    scheduledContinuations.delete(sessionID)
    taskDeferredSessions.delete(sessionID)
  }

  async function recoverContextOverflow(sessionID: string, error: unknown) {
    if (contextRecoverySessions.has(sessionID)) return true
    if (contextRecoveryEpisodes.has(sessionID)) return false
    const goal = await getGoal(sessionID)
    const model = lastPromptRuntime.get(sessionID)?.model ?? goal?.lastPromptModel ?? null
    if (goal?.status !== "active" || !model || typeof client.session.summarize !== "function") return false

    const episode = {
      promptGeneration: goal.promptGeneration,
      autoTurns: goal.autoTurns,
      assistantMessageID: goal.lastAssistantMessageID,
      assistantText: goal.lastAssistantText,
    }
    contextRecoveryEpisodes.set(sessionID, episode)
    contextRecoverySessions.add(sessionID)
    busySessions.delete(sessionID)
    cancelScheduledContinuation(sessionID)
    try {
      const result = await client.session.summarize({
        path: { id: sessionID },
        body: { providerID: model.providerID, modelID: model.modelID },
      })
      const summarized = isRecord(result) && "data" in result ? result.data : result
      if (summarized !== true) throw new Error("OpenCode did not confirm that session compaction completed.")
      const current = await getGoal(sessionID)
      if (
        current?.status !== "active" ||
        current.promptGeneration !== episode.promptGeneration ||
        contextRecoveryEpisodes.get(sessionID) !== episode
      ) {
        return true
      }
      errorStoppedSessions.delete(sessionID)
      scheduleSettledContinuation(sessionID)
      return true
    } catch (recoveryError) {
      const detail = `${runtimeErrorDetails(error).text} Context-overflow recovery failed: ${
        recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
      }`
      errorStoppedSessions.add(sessionID)
      await stopGoalForRuntimeError(sessionID, "blocked", detail)
      await client.app?.log?.({
        body: {
          service: "slash-goal-for-opencode",
          level: "error",
          message: "Context-overflow recovery failed",
          extra: { sessionID, error: recoveryError instanceof Error ? recoveryError.message : String(recoveryError) },
        },
      })
      return true
    } finally {
      contextRecoverySessions.delete(sessionID)
    }
  }

  function resetContextRecoveryAfterProgress(
    sessionID: string,
    message: { info?: unknown; role?: unknown; id?: unknown; parts?: unknown[] } | undefined,
    goal: GoalSnapshot | null | undefined,
  ) {
    const episode = contextRecoveryEpisodes.get(sessionID)
    if (!episode || !message || !goal) return
    if (messageRole(message) !== "assistant") return
    const currentMessageID = messageID(message) ?? ""
    const currentText = textFromMessage(message).trim()
    const promptedAfterRecovery = goal.promptGeneration > episode.promptGeneration
    const completedRecoveryContinuation =
      goal.autoTurns > episode.autoTurns &&
      goal.awaitingContinuationProgress &&
      (currentMessageID
        ? currentMessageID !== goal.continuationBaselineMessageID
        : Boolean(currentText && currentText !== goal.continuationBaselineSummary))
    if (!promptedAfterRecovery && !completedRecoveryContinuation) return
    if (
      (currentMessageID && currentMessageID !== episode.assistantMessageID) ||
      (currentText && currentText !== episode.assistantText.trim())
    ) {
      contextRecoveryEpisodes.delete(sessionID)
    }
  }

  function continuationFailureStreak(sessionID: string) {
    const existing = continuationFailureStreaks.get(sessionID)
    if (existing) return existing
    const created: ContinuationFailureStreak = {
      failures: 0,
      pendingAttempt: null,
      errorObserved: false,
      baselineMessageID: "",
      baselineSignature: "",
    }
    continuationFailureStreaks.set(sessionID, created)
    return created
  }

  function beginContinuationOutcomeAttempt(
    sessionID: string,
    reservation: ContinuationReservation,
    latestAssistant: { info?: unknown; role?: unknown; id?: unknown; parts?: unknown[] } | undefined,
    goal: GoalSnapshot,
  ) {
    if (reservation.kind !== "continuation") return
    const streak = continuationFailureStreak(sessionID)
    streak.baselineMessageID = messageID(latestAssistant ?? {}) ?? goal.lastAssistantMessageID
    streak.baselineSignature = assistantProgressSignature(latestAssistant) || assistantProgressSignature({
      role: "assistant",
      parts: goal.lastAssistantText ? [{ type: "text", text: goal.lastAssistantText }] : [],
    })
    streak.pendingAttempt = {
      reservation,
      baselineMessageID: streak.baselineMessageID,
      baselineSignature: streak.baselineSignature,
    }
    streak.errorObserved = false
  }

  function abandonContinuationOutcomeAttempt(sessionID: string, reservation: ContinuationReservation, errored: boolean) {
    const streak = continuationFailureStreaks.get(sessionID)
    if (!streak || !sameContinuationReservation(streak.pendingAttempt?.reservation, reservation)) return
    streak.pendingAttempt = null
    streak.errorObserved = errored
    if (!errored && streak.failures === 0) clearContinuationFailureStreak(sessionID)
  }

  function updateFailureBaseline(
    streak: ContinuationFailureStreak,
    latestAssistant: { info?: unknown; role?: unknown; id?: unknown; parts?: unknown[] } | undefined,
  ) {
    const id = latestAssistant ? messageID(latestAssistant) : undefined
    if (id) streak.baselineMessageID = id
    const signature = assistantProgressSignature(latestAssistant)
    if (signature) streak.baselineSignature = signature
  }

  function hasSuccessfulAssistantProgress(
    streak: ContinuationFailureStreak,
    latestAssistant: { info?: unknown; role?: unknown; id?: unknown; parts?: unknown[] } | undefined,
  ) {
    const signature = assistantProgressSignature(latestAssistant)
    if (!signature) return false
    const id = latestAssistant ? messageID(latestAssistant) ?? "" : ""
    return Boolean(
      (id && id !== streak.baselineMessageID) || (signature && signature !== streak.baselineSignature),
    )
  }

  async function failContinuationOutcomeAttempt(
    sessionID: string,
    reservation: ContinuationReservation,
    errorObserved: boolean,
  ) {
    const streak = continuationFailureStreaks.get(sessionID)
    if (!streak || !sameContinuationReservation(streak.pendingAttempt?.reservation, reservation)) return false
    streak.pendingAttempt = null
    streak.errorObserved = errorObserved
    streak.failures += 1
    if (streak.failures < maxPromptFailures) return false
    const current = await getGoal(sessionID)
    if (current?.status === "active") await setGoalStatus(sessionID, "paused")
    errorStoppedSessions.add(sessionID)
    cancelScheduledContinuation(sessionID)
    return true
  }

  async function handleIdleContinuation(sessionID: string) {
    const streak = continuationFailureStreaks.get(sessionID)
    if (!streak) {
      handledIdleEpisodes.add(sessionID)
      await runAutoContinue(sessionID)
      return
    }

    const latestAssistant = await fetchLatestAssistant(client, sessionID)
    taskTracker.observeAssistantMessage(sessionID, latestAssistant)
    if (!streak.errorObserved && hasSuccessfulAssistantProgress(streak, latestAssistant)) {
      clearContinuationFailureStreak(sessionID)
      handledIdleEpisodes.add(sessionID)
      await runAutoContinue(sessionID)
      return
    }

    if (streak.errorObserved) {
      updateFailureBaseline(streak, latestAssistant)
      streak.errorObserved = false
      handledIdleEpisodes.add(sessionID)
      await runAutoContinue(sessionID)
      return
    }

    const pending = streak.pendingAttempt
    if (pending) {
      if (handledIdleEpisodes.has(sessionID)) return
      handledIdleEpisodes.add(sessionID)
      updateFailureBaseline(streak, latestAssistant)
      const paused = await failContinuationOutcomeAttempt(sessionID, pending.reservation, false)
      if (!paused) await runAutoContinue(sessionID)
      return
    }

    if (handledIdleEpisodes.has(sessionID)) return
    handledIdleEpisodes.add(sessionID)
    await runAutoContinue(sessionID)
  }

  async function runAutoContinue(
    sessionID: string,
    fromTaskDeferral = false,
    source: ContinuationSource = "idle",
  ) {
    const allowBusy = source === "watchdog"
    if ((!allowBusy && busySessions.has(sessionID)) || errorStoppedSessions.has(sessionID) || contextRecoverySessions.has(sessionID)) return
    if (activeContinuations.has(sessionID)) return
    activeContinuations.add(sessionID)
    let reservation: ContinuationReservation | null = null
    try {
      const latestAssistant = await fetchLatestAssistant(client, sessionID)
      taskTracker.observeAssistantMessage(sessionID, latestAssistant)
      const taskStatus = await taskBlockStatus(sessionID)
      if (taskStatus && taskStatus.blocked) {
        taskDeferredSessions.add(sessionID)
        if (taskStatus.retryAt != null) scheduleSettledContinuation(sessionID, taskStatus.retryAt - Date.now())
        return
      }
      if ((!allowBusy && busySessions.has(sessionID)) || errorStoppedSessions.has(sessionID)) return
      await recordAssistantMessage(sessionID, latestAssistant, options ?? {}, true)
      const current = await getGoal(sessionID)
      if (!current) return
      const latestTurnAgent = agentFromMessage(latestAssistant)
      if (isPlanAgent(current.lastPromptAgent) || isPlanAgent(latestTurnAgent)) {
        if (current.status === "active") await pauseGoalForPlanMode(sessionID)
        return
      }
      if ((!allowBusy && busySessions.has(sessionID)) || errorStoppedSessions.has(sessionID)) return
      if (!fromTaskDeferral && taskDeferredSessions.has(sessionID)) {
        scheduleSettledContinuation(sessionID)
        return
      }
      taskDeferredSessions.delete(sessionID)
      const goal = await reserveContinuation(sessionID, maxAutoTurns, minInterval, current.promptGeneration)
      if (!goal) return
      reservation = goal.continuationReservation
      if (!reservation) return
      const latest = await getGoal(sessionID)
      if (
        (!allowBusy && busySessions.has(sessionID)) ||
        errorStoppedSessions.has(sessionID) ||
        !latest ||
        latest.status !== goal.status ||
        latest.promptGeneration !== goal.promptGeneration ||
        latest.autoTurns !== goal.autoTurns ||
        !sameContinuationReservation(latest.continuationReservation, reservation)
      ) {
        await cancelContinuationReservation(sessionID, reservation)
        abandonContinuationOutcomeAttempt(sessionID, reservation, false)
        reservation = null
        return
      }
      const prompt = continuationWirePrompt(
        goal.status === "active" ? continuationPrompt(goal) : limitPrompt(goal),
        reservation,
      )
      beginContinuationOutcomeAttempt(sessionID, reservation, latestAssistant, goal)
      pendingContinuationPrompts.set(sessionID, { prompt, reservation, source })
      try {
        await sendContinuation(
          client,
          sessionID,
          prompt,
          goal.lastPromptAgent ?? latestTurnAgent ?? null,
          goal.lastPromptModel,
        )
      } finally {
        const pending = pendingContinuationPrompts.get(sessionID)
        if (sameContinuationReservation(pending?.reservation, reservation)) pendingContinuationPrompts.delete(sessionID)
      }
      await recordContinuationResult(sessionID, reservation, "success", maxPromptFailures)
    } catch (error) {
      const disposition = runtimeErrorDisposition(error)
      const failedGoal = reservation
        ? await recordContinuationResult(sessionID, reservation, "failure", maxPromptFailures)
        : null
      if (reservation) {
        if (disposition === "transport") {
          await failContinuationOutcomeAttempt(sessionID, reservation, true)
        } else {
          abandonContinuationOutcomeAttempt(sessionID, reservation, true)
        }
      }
      if (failedGoal?.status === "paused") errorStoppedSessions.add(sessionID)
      await client.app?.log?.({
        body: {
          service: "slash-goal-for-opencode",
          level: "error",
          message: source === "watchdog" ? "Turn watchdog retry failed" : "Auto-continue failed",
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
      for (const watchdog of turnWatchdogs.values()) clearTimeout(watchdog.timer)
      turnWatchdogs.clear()
      watchdogRescuedSessions.clear()
      errorStoppedSessions.clear()
      continuationFailureStreaks.clear()
      handledIdleEpisodes.clear()
      contextRecoverySessions.clear()
      contextRecoveryEpisodes.clear()
      lastPromptRuntime.clear()
      pendingGoalCommands.clear()
      pendingContinuationPrompts.clear()
    },
    async config(config) {
      if (!registerCommand) return
      registerDesktopCommand(config, commandName)
    },
    async "command.execute.before"(input) {
      const invoked = input.command.trim().replace(/^\//, "")
      if (invoked !== commandName) return
      pendingGoalCommands.set(input.sessionID, { arguments: input.arguments.trim(), expiresAt: Date.now() + 30_000 })
    },
    tool: {
      get_goal: {
        description:
          "Get the current goal for this session, including status, budgets, token and elapsed-time usage, and remaining token budget.",
        args: {},
        async execute(_args, context) {
          const goal = goalWithContinuationFailureStreak(context.sessionID, await getGoal(context.sessionID))
          return JSON.stringify(goalToolResponse(goal), null, 2)
        },
      },
      create_goal: {
        description: `Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks.
Set token_budget only when an explicit token budget is requested. Fails if an unfinished goal exists; use update_goal only for status.
While the session is in Plan mode, the goal is recorded as paused and execution requires the user to switch to Build mode.`,
        args: {
          objective: z
            .string()
            .min(1)
            .max(4000)
            .describe(
              "Required. The concrete objective to start pursuing. This starts a new active goal when no goal exists or replaces the current goal when it is complete.",
            ),
          token_budget: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Positive token budget for the new goal. Omit unless explicitly requested."),
        },
        async execute(args, context) {
          return createGoalFromTool(args as CreateGoalArgs, context)
        },
      },
      update_goal: {
        description: `Update the existing goal.
Use this tool only to mark the goal achieved or genuinely blocked.
Set status to complete only when the objective has actually been achieved and no required work remains.
Set status to blocked only when the same blocking condition has repeated for at least three consecutive goal turns, counting the original/user-triggered turn and any automatic continuations, and the agent cannot make meaningful progress without user input or an external-state change.
If the user resumes a goal that was previously marked blocked, treat the resumed run as a fresh blocked audit. If the same blocking condition then repeats for at least three consecutive resumed goal turns, set status to blocked again.
Once the blocked threshold is satisfied, do not keep reporting that you are still blocked while leaving the goal active; set status to blocked.
Do not use blocked merely because the work is hard, slow, uncertain, incomplete, or would benefit from clarification.
Do not mark a goal complete merely because its budget is nearly exhausted or because you are stopping work.
You cannot use this tool to pause, resume, budget-limit, or usage-limit a goal; those status changes are controlled by the user or system.
When marking a budgeted goal achieved with status complete, report the final token usage from the tool result to the user.`,
        args: {
          status: z
            .enum(["complete", "blocked"])
            .describe(
              "Required. Set to complete only when the objective is achieved and no required work remains. Set to blocked only after the same blocker has repeated for at least three consecutive goal turns and the agent is at an impasse.",
            ),
        },
        async execute(args, context) {
          const input = args as UpdateGoalArgs
          if (input.status === "complete") {
            const goal = await completeGoal(context.sessionID)
            const completionBudgetReport =
              goal.tokenBudget == null && goal.timeUsedSeconds <= 0
                ? null
                : "Goal achieved. Report final usage from this tool result's structured goal fields. If goal.tokenBudget is present, include token usage from goal.tokensUsed and goal.tokenBudget. If goal.timeUsedSeconds is greater than 0, summarize elapsed time in a concise, human-friendly form appropriate to the response language."
            return JSON.stringify(goalToolResponse(goal, completionBudgetReport), null, 2)
          }
          const goal = await markGoalBlocked(context.sessionID)
          return JSON.stringify(goalToolResponse(goal), null, 2)
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
      if (typeof sessionID !== "string") return
      // This hook runs at prompt acceptance, before the status event is
      // guaranteed to report busy. Marking it synchronously closes the idle
      // continuation race for real steering messages and plugin prompts alike.
      busySessions.add(sessionID)
      cancelScheduledContinuation(sessionID)
      const agent =
        typeof input?.agent === "string" && input.agent.trim()
          ? input.agent.trim()
          : typeof output.message?.agent === "string" && output.message.agent.trim()
            ? output.message.agent.trim()
            : null
      const runtime = { agent, model: normalizedModel(input.model) }
      lastPromptRuntime.set(sessionID, runtime)
      const expandedCommand = commandInvocation(output.parts as unknown[], commandName)
      const pendingCommand = pendingGoalCommands.get(sessionID)
      pendingGoalCommands.delete(sessionID)
      const command =
        pendingCommand &&
        pendingCommand.expiresAt >= Date.now() &&
        expandedCommand !== undefined &&
        pendingCommand.arguments === expandedCommand
          ? expandedCommand
          : undefined
      const pendingContinuation = pendingContinuationPrompts.get(sessionID)
      const acceptedContinuation = acceptContinuationPrompt(output.parts as unknown[], pendingContinuation)
      if (acceptedContinuation && pendingContinuation) {
        if (pendingContinuation.source === "watchdog") watchdogRescuedSessions.add(sessionID)
        await recordContinuationPromptRuntime(sessionID, pendingContinuation.reservation, {
          ...runtime,
          countGoalTurn: true,
        })
      } else {
        clearWatchdogEpisode(sessionID)
        handledIdleEpisodes.delete(sessionID)
        const pendingOutcome = continuationFailureStreaks.get(sessionID)?.pendingAttempt
        if (pendingOutcome) abandonContinuationOutcomeAttempt(sessionID, pendingOutcome.reservation, false)
        await recordPromptRuntime(sessionID, { ...runtime, countGoalTurn: command === undefined })
      }
      if (command !== undefined) {
        try {
          replaceCommandMessage(output.parts as unknown[], await handleGoalCommand(sessionID, command, runtime))
        } catch (error) {
          replaceCommandMessage(
            output.parts as unknown[],
            `The /${commandName} command was not applied: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
        return
      }
    },
    async "experimental.chat.messages.transform"(input, output) {
      taskTracker.observeMessages(output.messages)
      const sessionID =
        "sessionID" in input && typeof input.sessionID === "string"
          ? input.sessionID
          : output.messages.find((message) => typeof message.info.sessionID === "string")?.info.sessionID
      if (!sessionID) return
      const message = latestAssistantMessage(output.messages)
      if (!continuationFailureStreaks.has(sessionID) || assistantProgressSignature(message)) {
        handledIdleEpisodes.delete(sessionID)
      }
      const goal = await recordAssistantMessage(sessionID, message, options ?? {})
      resetContextRecoveryAfterProgress(sessionID, message, goal)
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
          if (status.type === "busy") {
            busySessions.add(sessionID)
            handledIdleEpisodes.delete(sessionID)
            armTurnWatchdog(sessionID)
          }
          if (status.type === "idle") {
            busySessions.delete(sessionID)
            clearWatchdogEpisode(sessionID)
          }
          if (status.type === "retry") {
            busySessions.delete(sessionID)
            clearWatchdogEpisode(sessionID)
          }
          taskTracker.observeSessionStatus(sessionID, status.type)
        }
      }
      if (sessionID && eventType === "session.idle") {
        busySessions.delete(sessionID)
        clearWatchdogEpisode(sessionID)
        taskTracker.observeSessionStatus(sessionID, "idle")
      }
      if (sessionID && eventType === "session.deleted") {
        busySessions.delete(sessionID)
        clearWatchdogEpisode(sessionID)
        errorStoppedSessions.delete(sessionID)
        clearContinuationFailureStreak(sessionID)
        contextRecoverySessions.delete(sessionID)
        contextRecoveryEpisodes.delete(sessionID)
        cancelScheduledContinuation(sessionID)
        lastPromptRuntime.delete(sessionID)
        pendingGoalCommands.delete(sessionID)
        taskTracker.observeSessionDeleted(sessionID)
      }
      if (sessionID && (event as { type?: string }).type === "message.updated") {
        const props = (event as { properties?: Record<string, unknown> }).properties ?? {}
        const message = [props.info, props.message].find((value) => value && typeof value === "object") as
          | { info?: unknown; role?: unknown; id?: unknown; time?: unknown; parts?: unknown[] }
          | undefined
        if (!continuationFailureStreaks.has(sessionID) || assistantProgressSignature(message)) {
          handledIdleEpisodes.delete(sessionID)
        }
        taskTracker.observeAssistantMessage(sessionID, message)
        const goal = await recordAssistantMessage(sessionID, message, options ?? {})
        resetContextRecoveryAfterProgress(sessionID, message, goal)
      }

      if (sessionID && eventType === "session.error") {
        busySessions.delete(sessionID)
        clearWatchdogEpisode(sessionID)
        const properties = (event as { properties?: Record<string, unknown> }).properties ?? {}
        const disposition = runtimeErrorDisposition(properties.error)
        if (disposition === "contextOverflow" && (await recoverContextOverflow(sessionID, properties.error))) return
        if (disposition === "transport") {
          const goal = await getGoal(sessionID)
          if (goal?.status === "active") {
            const streak = continuationFailureStreak(sessionID)
            const pending = streak.pendingAttempt
            if (pending) await failContinuationOutcomeAttempt(sessionID, pending.reservation, true)
            else streak.errorObserved = true
            handledIdleEpisodes.delete(sessionID)
            cancelScheduledContinuation(sessionID)
          }
          return
        }
        errorStoppedSessions.add(sessionID)
        cancelScheduledContinuation(sessionID)
        if (disposition === "interrupted") {
          await pauseGoalForUserInterrupt(sessionID, runtimeErrorDetails(properties.error).text)
        } else {
          await stopGoalForRuntimeError(
            sessionID,
            disposition === "contextOverflow" ? "blocked" : disposition,
            runtimeErrorDetails(properties.error).text,
          )
        }
      }

      if (!autoContinue || !isIdleEvent(event as never)) return
      if (!sessionID) return
      await handleIdleContinuation(sessionID)
    },
  }
}

export default {
  id: "slash-goal-for-opencode.server",
  server,
}
