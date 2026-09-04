import type { Config, Plugin } from "@opencode-ai/plugin"
import type * as PluginV2 from "@opencode-ai/plugin-v2"
import type { Info as ToolV2Info } from "@opencode-ai/plugin-v2/promise/tool"
import type { Tool as ToolSchema } from "@opencode-ai/schema/tool"
import { z } from "zod"
import type { GoalSnapshot, InternalGoalSnapshot, PendingAttempt } from "./state"
import {
  accountUsage,
  clearGoal,
  completeGoal,
  createGoal,
  estimateTokensFromText,
  formatGoalHistory,
  getAllGoals,
  getGoal,
  getGoalInternal,
  markGoalUnmet,
  onStateRecovery,
  pauseGoalForPlanMode,
  PLAN_MODE_STOP_REASON,
  recordAssistantProgress,
  recordContinuationResult,
  recordPromptAgent,
  recordToolProgress,
  markPendingContinuationStarted,
  reserveContinuation,
  rollbackContinuationAttempt,
  setGoalStatus,
  statePath,
  updateGoalObjective,
  validateObjective,
} from "./state"
import { compactionContext, continuationPrompt, limitPrompt, systemReminder } from "./prompts"

type Options = {
  auto_continue?: boolean
  defer_while_tasks_active?: boolean
  max_auto_turns?: number
  min_continue_interval_seconds?: number
  max_turn_time?: number
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
const TASK_SETTLE_DELAY_MS = 25
const SNAPSHOT_IDLE_HOLD_MS = 250
const MAX_TIMER_DELAY_MS = 2_147_483_647
const STALE_PENDING_MS = 30_000
const RETRY_SETTLE_MS = 25
const TRANSPORT_ERROR_PATTERN =
  /\b(?:network|fetch|socket|connect|connection|timeout|timed out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|transport|stream|websocket|offline|internet|request failed|proxy)\b/i
const NON_TRANSPORT_TERMINAL_PATTERN = /\b(?:abort(?:ed)?|interrupt(?:ed|ion)?)\b/i
const NON_PROGRESS_TOOLS = new Set(["get_goal", "get_goal_history", "list_all_goals"])
const TASK_TERMINAL_STATES = new Set<TaskState>(["completed", "error", "cancelled"])
const PLAN_MODE_CREATE_NOTICE =
  'Goal recorded while the session is in Plan mode, so execution is paused. Do not start implementation work now. Ask the user to switch to Build mode and resume the goal (for example with "/goal resume") to begin execution.'
const LIMITED_GOAL_NOTICE =
  "Safety limit reached. Do not start or continue substantive work for this goal. Summarize useful progress, remaining work, and blockers, then wait for the user to resume or edit the goal."
const DUPLICATE_GOAL_NOTICE =
  "This non-closed goal already exists. Do not call create_goal or set_goal again. The existing objective and limits were preserved; repeated-call arguments were not applied. Use the returned goal state and continue only when its status permits execution."
const CONFLICTING_GOAL_NOTICE =
  "A different non-closed goal already exists. Do not call create_goal or set_goal again. Report the conflict instead of replacing the goal; edit, clear, complete, or mark it unmet only when explicitly requested."
const RESTRICTED_GOAL_NOTICE =
  "Goal execution is not allowed from the current restricted agent or while the goal is paused for Plan mode. Switch to Build mode and resume the goal before doing substantive work."
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

type TurnWatchdog = {
  timer: ReturnType<typeof setTimeout>
}

type ScheduledContinuation = {
  timer: ReturnType<typeof setTimeout>
  purpose: "settle" | "recovery" | "retry"
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
- Otherwise, call get_goal first. If it returns a non-closed goal with the same objective, do not create it again; continue working from the returned state. If it returns a different non-closed goal, report that conflict instead of replacing it. Only when there is no non-closed goal, call create_goal once. Use the full arguments as the objective. If the user includes explicit budget instructions, pass token_budget, max_auto_turns, or max_duration_seconds to create_goal rather than leaving those words in the objective.

Create a goal only from these explicit command arguments. Do not infer a goal from unrelated session context. After create_goal succeeds or returns an existing matching goal, never call it again for this command; continue working from the returned goal state.`
}

function goalStatusCommandTemplate(commandName: "pause_goal" | "resume_goal") {
  if (commandName === "pause_goal") {
    return `OpenCode goal mode command "/pause_goal" was invoked.

The command handler pauses an active goal before this acknowledgement turn when possible. Ignore any command arguments, call get_goal first, then handle only this pause request:

- If there is no goal, briefly report that no goal is set.
- If the goal is paused, do not mutate it again; briefly confirm "Goal paused."
- If the goal is still active, call update_goal_status with status "paused" and briefly report the result.
- If the goal is budgetLimited or usageLimited, do not mutate it; briefly report that it remains stopped by its safety limit.
- If the goal is complete or unmet, do not mutate it; briefly report that it is closed.

Do not create, resume, or continue a goal. Do not edit, clear, complete, or mark a goal unmet.`
  }

  return `OpenCode goal mode command "/resume_goal" was invoked.

Ignore any command arguments. Call get_goal first, then handle only this resume request:

- If there is no goal, briefly report that no goal is set.
- If the goal is complete or unmet, do not mutate it; you must not reopen it.
- If the goal is already active, do not mutate it; continue working toward its existing objective.
- If the goal is paused, budgetLimited, or usageLimited, call update_goal_status with status "active", then continue working toward its existing objective.
- If Plan mode or another restricted agent prevents resuming, report that the user must switch to Build mode instead of retrying.

Do not create, edit, clear, complete, or mark a goal unmet.`
}

type GoalCommandDefinition = {
  name: string
  description: string
  template: string
  action: "goal" | "pause" | "resume"
}

function goalCommandDefinitions(commandName: string): GoalCommandDefinition[] {
  return [
    {
      name: commandName,
      description: "Set or view the long-running session goal",
      template: goalCommandTemplate(commandName),
      action: "goal",
    },
    {
      name: "pause_goal",
      description: "Pause the current long-running session goal",
      template: goalStatusCommandTemplate("pause_goal"),
      action: "pause",
    },
    {
      name: "resume_goal",
      description: "Resume the current long-running session goal",
      template: goalStatusCommandTemplate("resume_goal"),
      action: "resume",
    },
  ]
}

function commandNameFromOptions(options?: Options) {
  const name = options?.command_name?.trim() || DEFAULT_COMMAND_NAME
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return DEFAULT_COMMAND_NAME
  if (name.toLowerCase() === "pause_goal" || name.toLowerCase() === "resume_goal") return DEFAULT_COMMAND_NAME
  return name
}

function positiveIntegerOrNull(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null
}

function nonNegativeIntegerOrNull(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function timeoutMillisecondsFromSeconds(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null
  return Math.min(Math.ceil(value * 1000), MAX_TIMER_DELAY_MS)
}

function registerDesktopCommands(config: Config, commandName: string) {
  config.command ??= {}
  const commands = goalCommandDefinitions(commandName)
  for (const command of commands) {
    if (config.command[command.name]) continue
    config.command[command.name] = {
      description: command.description,
      template: command.template,
    }
  }
}

function sanitizeGoalStatusCommandParts(output: { parts: Array<{ type: string; text?: string }> }, template: string) {
  const text = output.parts.find((part) => part.type === "text" && part.text?.startsWith(template))
  if (!text) return false
  text.text = template
  output.parts.splice(0, output.parts.length, text)
  return true
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

function usageFromMessages(messages: { info?: unknown; parts?: unknown[] }[]) {
  const exactTotal = messages.reduce<number>((sum, message) => sum + (exactTokensFromMessage(message) ?? 0), 0)
  return exactTotal > 0
    ? { tokens: exactTotal, source: "v1.messages.exact" }
    : { tokens: estimateMessages(messages), source: "v1.messages.estimated" }
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

function isTransportError(error: unknown) {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : ""
  if (!message || NON_TRANSPORT_TERMINAL_PATTERN.test(message)) return false
  if (TRANSPORT_ERROR_PATTERN.test(message)) return true
  return false
}

function transportErrorMessageFromEvent(props: Record<string, unknown>) {
  for (const candidate of [props.error, props.message, props.reason]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim()
    if (isRecord(candidate)) {
      for (const key of ["message", "error", "reason", "description"]) {
        const value = candidate[key]
        if (typeof value === "string" && value.trim()) return value.trim()
      }
    }
  }
  return ""
}

// Retry after the remaining minimum interval measured from the attempt's
// millisecond anchor. The public lastContinuationAt field remains in seconds.
function continuationRetryDelayMs(minIntervalSeconds: number, attemptAt: number, now = Date.now()) {
  return Math.max(0, attemptAt + minIntervalSeconds * 1000 - now) + RETRY_SETTLE_MS
}

function continuationDelayFromSnapshot(minIntervalSeconds: number, lastContinuationAt: number | null, now = Date.now()) {
  if (lastContinuationAt == null) return RETRY_SETTLE_MS
  // lastContinuationAt is floor(seconds), so include the remainder of that
  // second to guarantee reserveContinuation cannot wake too early and wedge.
  return Math.max(0, (lastContinuationAt + minIntervalSeconds + 1) * 1000 - now) + RETRY_SETTLE_MS
}

function pendingAttemptOf(goal: InternalGoalSnapshot | null): PendingAttempt | null {
  return goal?.pendingAttempt ?? null
}

// A reserved-and-delivered attempt warrants an unresolved no-response failure
// when the provider actually picked it up (a busy fired) or when the attempt
// went stale after a plugin restart. A locally delivered-but-unstarted attempt
// is left alone: a paired duplicate idle before any busy must never count a
// failure or send a duplicate.
function pendingReadyForFailure(attempt: PendingAttempt | null, deliveredLocally: boolean, now = Date.now()) {
  if (!attempt) return false
  if (attempt.started) return true
  if (deliveredLocally) return false
  return now - attempt.reservedAt >= STALE_PENDING_MS
}

// Substantive assistant progress that resolved the current pending attempt must
// clear the locally-delivered marker. A stale marker would mask a later
// locally-delivered-but-unstarted attempt from its stale-recovery path,
// wedging the next continuation.
async function reconcileLocalMarkerAfterProgress(
  locallyDelivered: Set<string>,
  sessionID: string,
  goal: GoalSnapshot | null,
) {
  if (!goal || goal.continuationFailures !== 0) return
  const internal = await getGoalInternal(sessionID)
  if (internal && internal.pendingAttempt == null) locallyDelivered.delete(sessionID)
}

const TOOL_FAILURE_STATES = new Set([
  "failed",
  "failure",
  "error",
  "cancelled",
  "canceled",
  "aborted",
  "abort",
  "interrupted",
  "running",
  "pending",
  "in_progress",
  "in-progress",
  "incomplete",
  "partial",
  "timeout",
  "timed_out",
])

function toolOutputFailed(output: unknown) {
  if (!isRecord(output)) return true
  if (typeof output.error === "string" && output.error.trim()) return true
  if (output.success === false) return true
  const text = typeof output.output === "string" ? output.output.trim() : ""
  const state = output.state ?? output.status
  if (typeof state === "string") {
    const normalized = state.trim().toLowerCase()
    if (TOOL_FAILURE_STATES.has(normalized)) return true
    if (["completed", "complete", "success", "succeeded", "ok", "done"].includes(normalized)) return false
  }
  if (isRecord(output.metadata)) {
    const metaState = output.metadata.state ?? output.metadata.status
    if (typeof metaState === "string" && TOOL_FAILURE_STATES.has(metaState.trim().toLowerCase())) return true
  }
  const taskState = parseTaskState(text)
  if (taskState) return taskState !== "completed"
  if (/^state:\s*(failed|failure|error|cancelled|canceled|aborted|abort|interrupted|running|pending|incomplete|partial|timeout|timed_out)\b/im.test(text)) return true
  if (/^<error>/i.test(text) || /^<tool-error>/i.test(text) || /^error:/i.test(text)) return true
  return false
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
    if (typeof input.tool !== "string" || !["task", "subagent"].includes(input.tool.toLowerCase())) return
    if (typeof input.sessionID !== "string") return
    if (typeof input.callID === "string") this.pendingTaskCalls.set(input.callID, input.sessionID)
  }

  noteTaskOutput(input: { tool?: unknown; sessionID?: unknown; callID?: unknown }, output: { output?: unknown }) {
    if (typeof input.tool !== "string" || !["task", "subagent"].includes(input.tool.toLowerCase())) return
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
  message: { info?: unknown; role?: unknown; id?: unknown; parts?: unknown[]; time?: unknown } | undefined,
  options: Options,
  evaluateContinuation = false,
) {
  if (!message) return { goal: null, progressed: false }
  const before = await getGoal(sessionID)
  const id = messageID(message) ?? ""
  const text = textFromMessage(message)
  const progressed = Boolean(
    /[\p{L}\p{N}]/u.test(text) && (id !== (before?.lastAssistantMessageID ?? "") || text !== (before?.lastAssistantText ?? "")),
  )
  const goal = await recordAssistantProgress(sessionID, {
    messageID: id,
    text,
    outputTokens: outputTokensFromMessage(message) ?? null,
    noProgressTokenThreshold: positiveIntegerOrNull(options.no_progress_token_threshold),
    maxNoProgressTurns: positiveIntegerOrNull(options.max_no_progress_turns),
    evaluateContinuation,
    completedAt: messageCompletedAt(message),
  })
  return { goal, progressed }
}

function mergeSystemReminder(output: { system: string[] }, reminder: string) {
  if (!reminder.trim()) return
  if (output.system.some((block) => block.includes(reminder))) return
  if (output.system.length === 0) {
    output.system.push(reminder)
    return
  }
  output.system[0] = `${output.system[0]}\n\n${reminder}`
}

function getGoalToolResult(goal: GoalSnapshot | null) {
  const result: { goal: GoalSnapshot | null; goal_mode_notice?: string } = { goal }
  if (goal?.status === "budgetLimited" || goal?.status === "usageLimited") {
    result.goal_mode_notice = LIMITED_GOAL_NOTICE
  }
  return JSON.stringify(result, null, 2)
}

type ToolExecContext = {
  sessionID: string
  agent?: string
}

type GoalServices = {
  options: Options
  isPlanAgent: (agent: unknown) => boolean
  initializeUsage?: (sessionID: string) => Promise<void>
}

async function createGoalFromTool(input: CreateGoalArgs, context: ToolExecContext, services: GoalServices) {
  const planningOnly = services.isPlanAgent(context.agent)
  const objective = validateObjective(input.objective)
  const existing = await getGoal(context.sessionID)
  if (existing && !isClosedGoal(existing)) return existingGoalResult(existing, objective, planningOnly)

  let goal: GoalSnapshot
  try {
    goal = await createGoal(context.sessionID, input.objective, {
      tokenBudget: input.token_budget ?? services.options.default_token_budget ?? null,
      maxAutoTurns: input.max_auto_turns ?? null,
      maxDurationSeconds: input.max_duration_seconds ?? services.options.max_goal_duration_seconds ?? null,
      noProgressTokenThreshold: services.options.no_progress_token_threshold ?? null,
      maxNoProgressTurns: services.options.max_no_progress_turns ?? null,
      agent: typeof context.agent === "string" ? context.agent : null,
      initialStatus: planningOnly ? "paused" : "active",
    })
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("non-closed goal")) throw error
    const raced = await getGoal(context.sessionID)
    if (raced && !isClosedGoal(raced)) return existingGoalResult(raced, objective, planningOnly)
    throw error
  }
  await services.initializeUsage?.(context.sessionID)
  return JSON.stringify(planningOnly ? { goal, plan_mode_notice: PLAN_MODE_CREATE_NOTICE } : { goal }, null, 2)
}

function isClosedGoal(goal: GoalSnapshot) {
  return goal.status === "complete" || goal.status === "unmet"
}

function existingGoalResult(goal: GoalSnapshot, requestedObjective: string, planningOnly: boolean) {
  const reused = goal.objective === requestedObjective
  return JSON.stringify(
    {
      goal,
      ...(reused
        ? { goal_reused: true, duplicate_goal_notice: DUPLICATE_GOAL_NOTICE }
        : { goal_conflict: true, goal_conflict_notice: CONFLICTING_GOAL_NOTICE }),
      ...(goal.status === "budgetLimited" || goal.status === "usageLimited"
        ? { goal_mode_notice: LIMITED_GOAL_NOTICE }
        : {}),
      ...(planningOnly || goal.stopReason === PLAN_MODE_STOP_REASON ? { plan_mode_notice: RESTRICTED_GOAL_NOTICE } : {}),
    },
    null,
    2,
  )
}

async function updateGoalObjectiveFromTool(
  input: { objective: string; status?: "active" | "paused" },
  context: ToolExecContext,
  services: GoalServices,
) {
  const requested = input.status ?? "active"
  const planningOnly = requested === "active" && services.isPlanAgent(context.agent)
  const goal = await updateGoalObjective(context.sessionID, input.objective, planningOnly ? "paused" : requested, {
    agent: typeof context.agent === "string" ? context.agent : null,
    planModePause: planningOnly,
  })
  return JSON.stringify(planningOnly ? { goal, plan_mode_notice: PLAN_MODE_CREATE_NOTICE } : { goal }, null, 2)
}

async function closeGoalFromTool(input: UpdateGoalArgs, context: ToolExecContext) {
  if (input.status === "complete") {
    const goal = await completeGoal(context.sessionID, input.evidence ?? "")
    const budget = goal.tokenBudget == null ? "" : ` Token usage: ${goal.tokensUsed}/${goal.tokenBudget}.`
    const report = `Goal achieved. Time used: ${goal.timeUsedSeconds} seconds.${budget} Evidence: ${goal.completionEvidence}.`
    return JSON.stringify({ goal, completion_report: report }, null, 2)
  }
  const goal = await markGoalUnmet(context.sessionID, input.blocker ?? "")
  const report = `Goal unmet. Time used: ${goal.timeUsedSeconds} seconds. Blocker: ${goal.blocker}.`
  return JSON.stringify({ goal, unmet_report: report }, null, 2)
}

async function updateGoalStatusFromTool(
  input: { status: "active" | "paused" },
  context: ToolExecContext,
  services: GoalServices,
) {
  if (input.status === "active" && services.isPlanAgent(context.agent)) {
    throw new Error(
      "cannot resume the goal while the session is in Plan mode; ask the user to switch to Build mode and resume the goal from there",
    )
  }
  const goal = await setGoalStatus(context.sessionID, input.status, typeof context.agent === "string" ? context.agent : null)
  return JSON.stringify({ goal }, null, 2)
}

function v2ObjectSchema(properties: Record<string, unknown>, required: string[] = []): ToolSchema.ValueSchema {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  } as ToolSchema.ValueSchema
}

type V2EventLike = {
  type: string
  created: number
  data: Record<string, unknown>
}

function decodeV2Event(value: unknown): V2EventLike | undefined {
  let decoded = value
  if (typeof decoded === "string") {
    try {
      decoded = JSON.parse(decoded)
    } catch {
      return undefined
    }
  }
  if (!isRecord(decoded) || typeof decoded.type !== "string" || !isRecord(decoded.data)) return undefined
  if (typeof decoded.created !== "number") return undefined
  return decoded as V2EventLike
}

type V2StepRecord = {
  messageID: string
  agent?: string
  text: string
  outputTokens: number | null
  completedAt: number | null
}

function textFromToolResult(result: { output?: unknown; content?: unknown }): string | undefined {
  if (typeof result.output === "string") return result.output
  if (typeof result.content === "string") return result.content
  if (Array.isArray(result.content)) {
    const text = result.content.map(textFromPart).filter(Boolean).join("\n").trim()
    return text || undefined
  }
  return undefined
}

// Tool calls are correlated to the pending attempt that was active when they
// started so a delayed output cannot clear a newer attempt. Keys are scoped by
// session and call id to avoid collisions between concurrent calls.
function toolAttemptKey(sessionID: string, callID: string) {
  return `${sessionID}\0${callID}`
}

function clearToolAttemptsForSession(attempts: Map<string, string | null>, sessionID: string) {
  for (const key of [...attempts.keys()]) {
    if (key.startsWith(`${sessionID}\0`)) attempts.delete(key)
  }
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
  const scheduledContinuations = new Map<string, ScheduledContinuation>()
  const turnWatchdogs = new Map<string, TurnWatchdog>()
  const busySessions = new Set<string>()
  const nativeRetrySessions = new Set<string>()
  const locallyDeliveredPendingSessions = new Set<string>()
  // Pending-attempt id captured at tool-call start, keyed by session+call id,
  // so a delayed tool output is only treated as progress for the attempt it
  // actually ran under. Entries are removed on execute.after, session deletion,
  // and dispose.
  const toolAttempts = new Map<string, string | null>()
  // Sessions whose busy episode already received a watchdog rescue. Cleared
  // when the episode ends (idle/deleted), so each busy episode rescues at most
  // once and a rescue prompt cannot recursively re-arm the watchdog.
  const watchdogRescuedSessions = new Set<string>()
  const planAgents = restrictedAgentSet(options)
  const isPlanAgent = (agent: unknown) => typeof agent === "string" && planAgents.has(agent.trim().toLowerCase())
  const goalServices: GoalServices = { options: options ?? {}, isPlanAgent }
  const stopStateRecoveryReporting = onStateRecovery(statePath(), async ({ stateFile, quarantineFile, outcome, error }) => {
    await client.app?.log?.({
      body: {
        service: "opencode-goal-plugin",
        level: "error",
        message:
          outcome === "quarantined"
            ? "Corrupt goal state quarantined before recovery"
            : outcome === "sourceChanged"
              ? "Goal state changed during recovery; refusing to overwrite it"
              : "Corrupt goal state could not be quarantined; continuing recovery",
        extra: { stateFile, quarantineFile, outcome, ...(error ? { error } : {}) },
      },
    })
  })
  // Set by dispose so in-flight operations triggered before disposal cannot
  // schedule new timers or invoke continuations afterward.
  let disposed = false

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

  function armTurnWatchdog(sessionID: string) {
    if (maxTurnTimeMs == null) return
    if (watchdogRescuedSessions.has(sessionID)) return
    clearTurnWatchdog(sessionID)
    const watchdog: TurnWatchdog = {
      timer: setTimeout(() => void runTurnWatchdog(sessionID, watchdog), maxTurnTimeMs),
    }
    const maybeUnref = watchdog.timer as { unref?: () => void }
    if (typeof maybeUnref.unref === "function") maybeUnref.unref()
    turnWatchdogs.set(sessionID, watchdog)
  }

  async function runTurnWatchdog(sessionID: string, watchdog: TurnWatchdog) {
    let claimedContinuation = false
    try {
      if (disposed) return
      if (
        turnWatchdogs.get(sessionID) !== watchdog ||
        !busySessions.has(sessionID) ||
        watchdogRescuedSessions.has(sessionID)
      )
        return
      const goal = await getGoal(sessionID)
      if (turnWatchdogs.get(sessionID) !== watchdog || !busySessions.has(sessionID)) return
      if (goal?.status !== "active" || isPlanAgent(goal.lastPromptAgent)) return
      const latestAssistant = await fetchLatestAssistant(client, sessionID)
      if (turnWatchdogs.get(sessionID) !== watchdog || !busySessions.has(sessionID)) return
      const latestTurnAgent = agentFromMessage(latestAssistant)
      if (isPlanAgent(latestTurnAgent)) return
      // Establish the pre-rescue baseline so this same historical message
      // cannot later be mistaken for progress from the rescue prompt.
      const observedBeforeRescue = await recordAssistantMessage(sessionID, latestAssistant, options ?? {})
      await reconcileLocalMarkerAfterProgress(locallyDeliveredPendingSessions, sessionID, observedBeforeRescue.goal)
      const taskStatus = await taskBlockStatus(sessionID)
      if (turnWatchdogs.get(sessionID) !== watchdog || !busySessions.has(sessionID)) return
      if (taskStatus && taskStatus.blocked) return
      const current = await getGoal(sessionID)
      if (turnWatchdogs.get(sessionID) !== watchdog || !busySessions.has(sessionID)) return
      if (current?.status !== "active" || isPlanAgent(current.lastPromptAgent) || activeContinuations.has(sessionID)) return

      turnWatchdogs.delete(sessionID)
      activeContinuations.add(sessionID)
      claimedContinuation = true
      watchdogRescuedSessions.add(sessionID)
      await sendContinuation(client, sessionID, continuationPrompt(current), current.lastPromptAgent ?? latestTurnAgent ?? null)
      // Watchdog rescues are untracked retries: a delivered prompt arms the
      // pending-continuation window but never consumes an auto-turn budget and
      // never arms the no-progress evaluation. The rescue delivers while the
      // session is already inside a busy episode, so the pending attempt is
      // marked started immediately, and this busy episode rescues only once.
      await recordContinuationResult(sessionID, "success", maxPromptFailures, { armNoProgress: false, started: true })
      locallyDeliveredPendingSessions.add(sessionID)
      clearTurnWatchdog(sessionID)
    } catch (error) {
      try {
        // Watchdog rescues share the same prompt-failure ceiling: recognized
        // transport errors accumulate toward max_prompt_failures without
        // consuming auto-turn budgets.
        if (claimedContinuation && isTransportError(error)) {
          await recordContinuationResult(sessionID, "failure", maxPromptFailures)
        }
        await client.app?.log?.({
          body: {
            service: "opencode-goal-plugin",
            level: "error",
            message: "Turn watchdog retry failed",
            extra: { error: error instanceof Error ? error.message : String(error) },
          },
        })
      } catch {
        return
      }
    } finally {
      if (claimedContinuation) activeContinuations.delete(sessionID)
      if (turnWatchdogs.get(sessionID) === watchdog) turnWatchdogs.delete(sessionID)
    }
  }

  function cancelScheduledContinuation(sessionID: string) {
    const scheduled = scheduledContinuations.get(sessionID)
    if (scheduled) clearTimeout(scheduled.timer)
    scheduledContinuations.delete(sessionID)
  }

  function scheduleSettledContinuation(
    sessionID: string,
    delayMs = TASK_SETTLE_DELAY_MS,
    replace = false,
    purpose: ScheduledContinuation["purpose"] = "settle",
  ) {
    if (disposed) return
    if (!replace && scheduledContinuations.has(sessionID)) return
    if (replace) cancelScheduledContinuation(sessionID)
    const scheduled = {} as ScheduledContinuation
    const timer = setTimeout(async () => {
      try {
        if (scheduledContinuations.get(sessionID) !== scheduled || nativeRetrySessions.has(sessionID)) return
        if (purpose === "retry") {
          const goal = await getGoalInternal(sessionID)
          if (!goal || (goal.continuationFailures === 0 && goal.pendingAttempt == null)) return
        }
        if (scheduledContinuations.get(sessionID) !== scheduled || nativeRetrySessions.has(sessionID)) return
        await runAutoContinue(sessionID, true, scheduled)
      } finally {
        if (scheduledContinuations.get(sessionID) === scheduled) scheduledContinuations.delete(sessionID)
      }
    }, Math.max(0, delayMs))
    scheduled.timer = timer
    scheduled.purpose = purpose
    const maybeUnref = timer as { unref?: () => void }
    if (typeof maybeUnref.unref === "function") maybeUnref.unref()
    scheduledContinuations.set(sessionID, scheduled)
  }

  async function runAutoContinue(
    sessionID: string,
    fromTaskDeferral = false,
    scheduled?: ScheduledContinuation,
  ) {
    if (disposed) return
    if (busySessions.has(sessionID)) return
    if (activeContinuations.has(sessionID)) return
    activeContinuations.add(sessionID)
    // Anchor for bounded-retry scheduling, declared at function scope so the
    // catch block can use it. Initialized to "now" as a safe default.
    let attemptReservedAt = Date.now()
    try {
      const latestAssistant = await fetchLatestAssistant(client, sessionID)
      taskTracker.observeAssistantMessage(sessionID, latestAssistant)
      const taskStatus = await taskBlockStatus(sessionID)
      if (taskStatus && taskStatus.blocked) {
        taskDeferredSessions.add(sessionID)
        if (taskStatus.retryAt != null) {
          scheduleSettledContinuation(sessionID, taskStatus.retryAt - Date.now(), scheduled != null)
        }
        return
      }
      if (busySessions.has(sessionID)) return
      const observed = await recordAssistantMessage(sessionID, latestAssistant, options ?? {}, true)
      await reconcileLocalMarkerAfterProgress(locallyDeliveredPendingSessions, sessionID, observed.goal)
      const queued = scheduledContinuations.get(sessionID)
      if (observed.progressed && queued?.purpose !== "settle") cancelScheduledContinuation(sessionID)
      if (scheduled && scheduledContinuations.get(sessionID) !== scheduled) return
      const current = await getGoalInternal(sessionID)
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

      // Pending-continuation resolution. A delivered prompt is armed with
      // started=false until a session.status busy event marks it started.
      // Paired duplicate idles before any busy must never count a failure or
      // send a duplicate, so started=false attempts are left alone until they
      // go stale (restart recovery). Once started, the following logical idle
      // with no substantive progress counts exactly one unresolved failure and
      // schedules a bounded retry at the remaining min interval.
      const attempt = pendingAttemptOf(current)
      if (current.status === "active" && attempt != null) {
        const deliveredLocally = locallyDeliveredPendingSessions.has(sessionID)
        if (!pendingReadyForFailure(attempt, deliveredLocally)) {
          return
        }
        const afterFailure = await recordContinuationResult(sessionID, "failure", maxPromptFailures, {
          requirePending: true,
        })
        if (afterFailure) locallyDeliveredPendingSessions.delete(sessionID)
        if (autoContinue && afterFailure?.status === "active") {
          scheduleSettledContinuation(
            sessionID,
            continuationRetryDelayMs(minInterval, attempt.reservedAt),
            true,
            "retry",
          )
        }
        return
      }

      // A retry or recovery timer is already scheduled for this session (for
      // example from a paired idle after an unresolved failure); let that timer
      // drive the next attempt instead of sending a duplicate now.
      const queuedBeforeReserve = scheduledContinuations.get(sessionID)
      if (queuedBeforeReserve && queuedBeforeReserve !== scheduled) return
      if (!autoContinue) return
      if (nativeRetrySessions.has(sessionID)) return

      // Reserve (and persist) the attempt BEFORE delivery so a racing busy can
      // correlate to it. The attempt stays reserved until delivery or rollback.
      const goal = await reserveContinuation(sessionID, maxAutoTurns, minInterval)
      if (!goal) return
      attemptReservedAt = goal.pendingAttempt?.reservedAt ?? Date.now()
      if (nativeRetrySessions.has(sessionID)) {
        await rollbackContinuationAttempt(sessionID)
        return
      }
      if (scheduled && scheduledContinuations.get(sessionID) !== scheduled) {
        await rollbackContinuationAttempt(sessionID)
        return
      }
      await sendContinuation(
        client,
        sessionID,
        goal.status === "active" ? continuationPrompt(goal) : limitPrompt(goal),
        goal.lastPromptAgent ?? latestTurnAgent ?? null,
      )
      if (disposed) {
        // The plugin was torn down while the prompt was in flight: roll the
        // reserved turn back instead of committing a continuation afterward.
        await rollbackContinuationAttempt(sessionID)
        return
      }
      // Commit the delivered attempt. A busy that raced the resolution already
      // marked it started (started=true is preserved).
      const delivered = await recordContinuationResult(sessionID, "success", maxPromptFailures)
      locallyDeliveredPendingSessions.add(sessionID)
      if (!delivered?.pendingAttempt?.delivered) {
        // The attempt was not present at delivery time (e.g. disposed mid-send):
        // do not leave a phantom reserved turn.
        await rollbackContinuationAttempt(sessionID)
      }
    } catch (error) {
      if (disposed) {
        // The plugin was torn down while the prompt was in flight and the
        // prompt then failed: the reserved attempt was never delivered, so
        // roll it back instead of counting a transport failure or consuming an
        // auto-turn.
        await rollbackContinuationAttempt(sessionID)
        return
      }
      if (isTransportError(error)) {
        // A transport failure is a real attempt: count it toward the
        // max_prompt_failures ceiling and schedule a bounded retry at the
        // remaining minimum interval. Keep the reserved autoTurn consumed.
        const afterFailure = await recordContinuationResult(sessionID, "failure", maxPromptFailures)
        if (autoContinue && afterFailure?.status === "active") {
          scheduleSettledContinuation(
            sessionID,
            continuationRetryDelayMs(minInterval, attemptReservedAt),
            true,
            "retry",
          )
        }
      } else {
        // Non-transport prompt errors (provider/config faults, aborts) are not
        // transport or no-response failures: they do not increment the ceiling
        // or auto-retry. Roll back the unconsumed reserved turn so it does not
        // waste an auto-continue budget, and preserve useful error logging.
        await rollbackContinuationAttempt(sessionID)
      }
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
      disposed = true
      stopStateRecoveryReporting()
      for (const scheduled of scheduledContinuations.values()) clearTimeout(scheduled.timer)
      scheduledContinuations.clear()
      for (const watchdog of turnWatchdogs.values()) clearTimeout(watchdog.timer)
      turnWatchdogs.clear()
      watchdogRescuedSessions.clear()
      locallyDeliveredPendingSessions.clear()
      nativeRetrySessions.clear()
      toolAttempts.clear()
    },
    async config(config) {
      if (!registerCommand) return
      registerDesktopCommands(config, commandName)
    },
    tool: {
      get_goal: {
        description:
          "Get the current goal for this OpenCode session, including status, observed token usage, elapsed-time usage, budgets, checkpoints, and history.",
        args: {},
        async execute(_args, context) {
          return getGoalToolResult(await getGoal(context.sessionID))
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
      list_all_goals: {
        description:
          "List up to 50 public goal summaries across all sessions in this state file, ordered by most recently updated first. Elapsed time is the last persisted value; total and truncated report omitted older goals.",
        args: {},
        async execute() {
          return JSON.stringify(await getAllGoals(), null, 2)
        },
      },
      create_goal: {
        description:
          "Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks. If any non-closed goal exists, this returns the existing goal as either reused or conflicting and must not be retried. While the session is in Plan mode, the goal is recorded as paused and execution requires the user to switch to Build mode.",
        args: {
          objective: z.string().min(1).max(4000).describe("The concrete objective to start pursuing."),
          token_budget: z.number().int().positive().nullable().optional().describe("Optional positive token budget."),
          max_auto_turns: z.number().int().positive().nullable().optional().describe("Optional per-goal auto-continue limit."),
          max_duration_seconds: z.number().int().positive().nullable().optional().describe("Optional per-goal duration limit."),
        },
        async execute(args, context) {
          return createGoalFromTool(args as CreateGoalArgs, context, goalServices)
        },
      },
      set_goal: {
        description:
          "Set a new goal when the user explicitly asks the agent to formulate and set its own goal. The model should write the objective itself based on the user's explicit request. If any non-closed goal exists, this returns the existing goal as either reused or conflicting and must not be retried. While the session is in Plan mode, the goal is recorded as paused and execution requires the user to switch to Build mode.",
        args: {
          objective: z.string().min(1).max(4000).describe("The model-formulated concrete objective to start pursuing."),
          token_budget: z.number().int().positive().nullable().optional().describe("Optional positive token budget."),
          max_auto_turns: z.number().int().positive().nullable().optional().describe("Optional per-goal auto-continue limit."),
          max_duration_seconds: z.number().int().positive().nullable().optional().describe("Optional per-goal duration limit."),
        },
        async execute(args, context) {
          return createGoalFromTool(args as CreateGoalArgs, context, goalServices)
        },
      },
      update_goal_objective: {
        description: "Edit the current OpenCode goal objective when the user explicitly asks to edit or replace it.",
        args: {
          objective: z.string().min(1).max(4000).describe("The updated concrete objective."),
          status: z.enum(["active", "paused"]).optional().describe("Whether the edited goal should be active or paused."),
        },
        async execute(args, context) {
          return updateGoalObjectiveFromTool(args as { objective: string; status?: "active" | "paused" }, context, goalServices)
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
          return closeGoalFromTool(args as UpdateGoalArgs, context)
        },
      },
      update_goal_status: {
        description:
          "Pause or resume the current OpenCode goal when the user explicitly asks to pause or resume it. Resuming is not allowed while the session is in Plan mode; the user must switch to Build mode first.",
        args: {
          status: z.enum(["active", "paused"]).describe("active resumes a goal; paused pauses it without clearing it."),
        },
        async execute(args, context) {
          return updateGoalStatusFromTool(args as { status: "active" | "paused" }, context, goalServices)
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
      const sessionID = typeof input?.sessionID === "string" ? input.sessionID : undefined
      const callID = typeof input?.callID === "string" ? input.callID : undefined
      if (sessionID && callID) {
        const goal = await getGoalInternal(sessionID)
        toolAttempts.set(toolAttemptKey(sessionID, callID), goal?.pendingAttempt?.id ?? null)
      }
    },
    async "command.execute.before"(input, output) {
      if (input.command !== "pause_goal" && input.command !== "resume_goal") return
      const template = goalStatusCommandTemplate(input.command)
      if (!sanitizeGoalStatusCommandParts(output, template)) return
      if (input.command !== "pause_goal") return
      const goal = await getGoal(input.sessionID)
      if (goal?.status === "active") await setGoalStatus(input.sessionID, "paused")
      cancelScheduledContinuation(input.sessionID)
      clearTurnWatchdog(input.sessionID)
    },
    async "tool.execute.after"(input, output) {
      taskTracker.noteTaskOutput(
        input as { tool?: unknown; sessionID?: unknown; callID?: unknown },
        output as { output?: unknown },
      )
      const sessionID = typeof input?.sessionID === "string" ? input.sessionID : undefined
      const callID = typeof input?.callID === "string" ? input.callID : undefined
      const attemptKey = sessionID && callID ? toolAttemptKey(sessionID, callID) : undefined
      const expectedAttemptID = attemptKey ? toolAttempts.get(attemptKey) : undefined
      if (attemptKey) toolAttempts.delete(attemptKey)
      if (!sessionID) return
      if (typeof input?.tool === "string" && NON_PROGRESS_TOOLS.has(input.tool.toLowerCase())) return
      const toolResult = output as { output?: unknown; error?: unknown }
      // A successful tool output is real progress: it resolves any pending
      // continuation and clears the prompt-failure counter. Failed tool
      // outputs leave the failure counter and pending window untouched.
      if (toolOutputFailed(toolResult)) return
      const text = typeof toolResult.output === "string" ? toolResult.output : undefined
      if (!text) return
      const before = await getGoalInternal(sessionID)
      const scheduled = scheduledContinuations.get(sessionID)
      const hasFailureEpisode = Boolean(
        before && (before.continuationFailures > 0 || before.pendingAttempt != null),
      )
      if (!before || (!hasFailureEpisode && scheduled?.purpose !== "recovery")) return
      const progressed = await recordToolProgress(sessionID, text, expectedAttemptID)
      if (progressed?.continuationFailures === 0 && progressed.pendingAttempt == null) {
        locallyDeliveredPendingSessions.delete(sessionID)
        cancelScheduledContinuation(sessionID)
      }
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
      const usage = usageFromMessages(output.messages)
      await accountUsage(sessionID, usage.tokens, { cumulative: true, source: usage.source })
      const observed = await recordAssistantMessage(sessionID, latestAssistantMessage(output.messages), options ?? {})
      await reconcileLocalMarkerAfterProgress(locallyDeliveredPendingSessions, sessionID, observed.goal)
      const scheduled = scheduledContinuations.get(sessionID)
      if (observed.progressed && scheduled?.purpose !== "settle") cancelScheduledContinuation(sessionID)
    },
    async "experimental.chat.system.transform"(input, output) {
      if (typeof input.sessionID !== "string") return
      mergeSystemReminder(output, systemReminder())
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
            nativeRetrySessions.delete(sessionID)
          }
          if (status.type === "busy") armTurnWatchdog(sessionID)
          if (status.type === "busy") await markPendingContinuationStarted(sessionID)
          if (status.type === "idle") {
            busySessions.delete(sessionID)
            nativeRetrySessions.delete(sessionID)
            clearTurnWatchdog(sessionID)
            watchdogRescuedSessions.delete(sessionID)
          }
          if (status.type === "retry") {
            nativeRetrySessions.add(sessionID)
            clearTurnWatchdog(sessionID)
            cancelScheduledContinuation(sessionID)
          }
          taskTracker.observeSessionStatus(sessionID, status.type)
        }
      }
      if (sessionID && eventType === "session.idle") {
        busySessions.delete(sessionID)
        nativeRetrySessions.delete(sessionID)
        clearTurnWatchdog(sessionID)
        watchdogRescuedSessions.delete(sessionID)
        taskTracker.observeSessionStatus(sessionID, "idle")
      }
      if (sessionID && eventType === "session.error") {
        const inNativeRetry = nativeRetrySessions.has(sessionID)
        busySessions.delete(sessionID)
        clearTurnWatchdog(sessionID)
        // A native provider retry episode is already recovering, so a transport
        // error inside it must not schedule plugin recovery. A retry status can
        // arrive before the error, so check the marker before clearing it; the
        // episode ends (and the marker is removed) on the next busy or idle.
        if (inNativeRetry) return
        nativeRetrySessions.delete(sessionID)
        watchdogRescuedSessions.delete(sessionID)
        const props = (event as { properties?: Record<string, unknown> }).properties ?? {}
        const errorMessage = transportErrorMessageFromEvent(props)
        if (errorMessage && isTransportError(errorMessage)) {
          const goal = await getGoalInternal(sessionID)
          if (goal?.status === "active") {
            const attempt = pendingAttemptOf(goal)
            if (attempt != null) {
              // The pending attempt failed at the transport level: count one
              // failure and retry at the remaining min interval.
              const afterFailure = await recordContinuationResult(sessionID, "failure", maxPromptFailures, {
                requirePending: true,
              })
              if (afterFailure) locallyDeliveredPendingSessions.delete(sessionID)
              if (autoContinue && afterFailure?.status === "active") {
                scheduleSettledContinuation(
                  sessionID,
                  continuationRetryDelayMs(minInterval, attempt.reservedAt),
                  true,
                  "retry",
                )
              }
            } else if (autoContinue) {
              // No pending attempt: start the first bounded automatic recovery
              // without charging a phantom failure. Duplicate transport events
              // dedupe through the scheduled-continuation timer.
              scheduleSettledContinuation(
                sessionID,
                continuationDelayFromSnapshot(minInterval, goal.lastContinuationAt),
                false,
                "recovery",
              )
            }
          }
        }
      }
      if (sessionID && eventType === "session.deleted") {
        busySessions.delete(sessionID)
        clearTurnWatchdog(sessionID)
        watchdogRescuedSessions.delete(sessionID)
        locallyDeliveredPendingSessions.delete(sessionID)
        nativeRetrySessions.delete(sessionID)
        cancelScheduledContinuation(sessionID)
        taskDeferredSessions.delete(sessionID)
        clearToolAttemptsForSession(toolAttempts, sessionID)
        taskTracker.observeSessionDeleted(sessionID)
      }
      if (sessionID && (event as { type?: string }).type === "message.updated") {
        const props = (event as { properties?: Record<string, unknown> }).properties ?? {}
        const message = [props.info, props.message].find((value) => value && typeof value === "object") as
          | { info?: unknown; role?: unknown; id?: unknown; time?: unknown; parts?: unknown[] }
          | undefined
        taskTracker.observeAssistantMessage(sessionID, message)
        const observed = await recordAssistantMessage(sessionID, message, options ?? {})
        await reconcileLocalMarkerAfterProgress(locallyDeliveredPendingSessions, sessionID, observed.goal)
        const scheduled = scheduledContinuations.get(sessionID)
        if (observed.progressed && scheduled?.purpose !== "settle") cancelScheduledContinuation(sessionID)
      }

      if (!isIdleEvent(event as never)) return
      if (!sessionID) return
      if (!autoContinue && (await getGoalInternal(sessionID))?.pendingAttempt == null) return
      await runAutoContinue(sessionID)
    },
  }
}

function v2ErrorLog(message: string, error: unknown) {
  try {
    console.error(`[opencode-goal-plugin] ${message}:`, error instanceof Error ? error.message : String(error))
  } catch {
    // Logging must never break plugin control flow.
  }
}

async function setupV2(context: PluginV2.Plugin.Context): Promise<PluginV2.Plugin.Cleanup> {
  const options = (context.options ?? {}) as Options
  const autoContinue = options.auto_continue ?? true
  const deferWhileTasksActive = options.defer_while_tasks_active ?? true
  const maxAutoTurns = positiveIntegerOrNull(options.max_auto_turns) ?? DEFAULT_MAX_AUTO_TURNS
  const minInterval = nonNegativeIntegerOrNull(options.min_continue_interval_seconds) ?? DEFAULT_CONTINUE_INTERVAL_SECONDS
  const maxTurnTimeMs = timeoutMillisecondsFromSeconds(options.max_turn_time)
  const maxPromptFailures = positiveIntegerOrNull(options.max_prompt_failures) ?? DEFAULT_MAX_PROMPT_FAILURES
  const registerCommand = options.register_command ?? true
  const commandName = commandNameFromOptions(options)
  const taskTracker = new TaskTracker()
  const taskDeferredSessions = new Set<string>()
  const scheduledContinuations = new Map<string, ScheduledContinuation>()
  const turnWatchdogs = new Map<string, TurnWatchdog>()
  const busySessions = new Set<string>()
  const nativeRetrySessions = new Set<string>()
  const locallyDeliveredPendingSessions = new Set<string>()
  const watchdogRescuedSessions = new Set<string>()
  // See the V1 comment: pending-attempt id captured at tool-call start so a
  // delayed tool output cannot clear a newer pending attempt.
  const toolAttempts = new Map<string, string | null>()
  const planAgents = restrictedAgentSet(options)
  const isPlanAgent = (agent: unknown) => typeof agent === "string" && planAgents.has(agent.trim().toLowerCase())
  const activeContinuationsV2 = new Set<string>()
  const latestStepBySession = new Map<string, V2StepRecord>()
  const stepTextBuffers = new Map<string, string>()
  const stepTokenSums = new Map<string, number>()
  const goalServices: GoalServices = {
    options,
    isPlanAgent,
    initializeUsage: async (sessionID) => {
      try {
        await accountUsage(sessionID, stepTokenSums.get(sessionID) ?? 0, { cumulative: true, source: "v2.steps" })
      } catch (error) {
        v2ErrorLog("Failed to initialize goal usage accounting", error)
      }
    },
  }
  const registrations: Array<{ dispose(): Promise<void> }> = []
  let disposed = false

  function stepKey(sessionID: string, messageID: string) {
    return `${sessionID}\0${messageID}`
  }

  async function sendContinuation(sessionID: string, prompt: string, agent?: string | null) {
    await context.session.prompt({
      sessionID,
      text: prompt,
      ...(agent ? { agents: [{ name: agent }] } : {}),
    })
  }

  function taskBlockStatus(sessionID: string) {
    if (!deferWhileTasksActive) return false
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

  function armTurnWatchdog(sessionID: string) {
    if (maxTurnTimeMs == null) return
    if (watchdogRescuedSessions.has(sessionID)) return
    clearTurnWatchdog(sessionID)
    const watchdog: TurnWatchdog = {
      timer: setTimeout(() => void runTurnWatchdog(sessionID, watchdog), maxTurnTimeMs),
    }
    const maybeUnref = watchdog.timer as { unref?: () => void }
    if (typeof maybeUnref.unref === "function") maybeUnref.unref()
    turnWatchdogs.set(sessionID, watchdog)
  }

  async function runTurnWatchdog(sessionID: string, watchdog: TurnWatchdog) {
    let claimedContinuation = false
    try {
      if (disposed) return
      if (turnWatchdogs.get(sessionID) !== watchdog || !busySessions.has(sessionID) || watchdogRescuedSessions.has(sessionID))
        return
      const goal = await getGoal(sessionID)
      if (turnWatchdogs.get(sessionID) !== watchdog || !busySessions.has(sessionID)) return
      if (goal?.status !== "active" || isPlanAgent(goal.lastPromptAgent)) return
      const latestStep = latestStepBySession.get(sessionID)
      if (isPlanAgent(latestStep?.agent)) return
      const taskStatus = taskBlockStatus(sessionID)
      if (turnWatchdogs.get(sessionID) !== watchdog || !busySessions.has(sessionID)) return
      if (taskStatus && taskStatus.blocked) return
      const current = await getGoalInternal(sessionID)
      if (turnWatchdogs.get(sessionID) !== watchdog || !busySessions.has(sessionID)) return
      if (current?.status !== "active" || isPlanAgent(current.lastPromptAgent) || activeContinuationsV2.has(sessionID)) return

      turnWatchdogs.delete(sessionID)
      activeContinuationsV2.add(sessionID)
      claimedContinuation = true
      watchdogRescuedSessions.add(sessionID)
      await sendContinuation(sessionID, continuationPrompt(current), current.lastPromptAgent ?? latestStep?.agent ?? null)
      // Watchdog rescues are untracked retries: a delivered prompt arms the
      // pending-continuation window but never consumes an auto-turn or
      // no-progress budget (armNoProgress: false). The rescue delivers while
      // already busy, so the pending attempt is marked started immediately.
      await recordContinuationResult(sessionID, "success", maxPromptFailures, { armNoProgress: false, started: true })
      locallyDeliveredPendingSessions.add(sessionID)
      clearTurnWatchdog(sessionID)
    } catch (error) {
      try {
        if (claimedContinuation && isTransportError(error)) {
          // Watchdog rescues share the same prompt-failure ceiling: recognized
          // transport errors accumulate toward max_prompt_failures without
          // consuming auto-turn budgets.
          await recordContinuationResult(sessionID, "failure", maxPromptFailures)
        }
        v2ErrorLog("Turn watchdog retry failed", error)
      } catch {
        return
      }
    } finally {
      if (claimedContinuation) activeContinuationsV2.delete(sessionID)
      if (turnWatchdogs.get(sessionID) === watchdog) turnWatchdogs.delete(sessionID)
    }
  }

  function cancelScheduledContinuation(sessionID: string) {
    const scheduled = scheduledContinuations.get(sessionID)
    if (scheduled) clearTimeout(scheduled.timer)
    scheduledContinuations.delete(sessionID)
  }

  function scheduleSettledContinuation(
    sessionID: string,
    delayMs = TASK_SETTLE_DELAY_MS,
    replace = false,
    purpose: ScheduledContinuation["purpose"] = "settle",
  ) {
    if (disposed) return
    if (!replace && scheduledContinuations.has(sessionID)) return
    if (replace) cancelScheduledContinuation(sessionID)
    const scheduled = {} as ScheduledContinuation
    const timer = setTimeout(async () => {
      try {
        if (scheduledContinuations.get(sessionID) !== scheduled || nativeRetrySessions.has(sessionID)) return
        if (purpose === "retry") {
          const goal = await getGoalInternal(sessionID)
          if (!goal || (goal.continuationFailures === 0 && goal.pendingAttempt == null)) return
        }
        if (scheduledContinuations.get(sessionID) !== scheduled || nativeRetrySessions.has(sessionID)) return
        await runAutoContinue(sessionID, true, scheduled)
      } finally {
        if (scheduledContinuations.get(sessionID) === scheduled) scheduledContinuations.delete(sessionID)
      }
    }, Math.max(0, delayMs))
    scheduled.timer = timer
    scheduled.purpose = purpose
    const maybeUnref = timer as { unref?: () => void }
    if (typeof maybeUnref.unref === "function") maybeUnref.unref()
    scheduledContinuations.set(sessionID, scheduled)
  }

  async function runAutoContinue(sessionID: string, fromTaskDeferral = false, scheduled?: ScheduledContinuation) {
    if (disposed) return
    if (busySessions.has(sessionID)) return
    if (activeContinuationsV2.has(sessionID)) return
    activeContinuationsV2.add(sessionID)
    let attemptReservedAt = Date.now()
    try {
      const latestStep = latestStepBySession.get(sessionID)
      if (latestStep?.messageID) {
        taskTracker.observeAssistantMessage(sessionID, { info: { id: latestStep.messageID, role: "assistant" } })
      }
      const taskStatus = taskBlockStatus(sessionID)
      if (taskStatus && taskStatus.blocked) {
        taskDeferredSessions.add(sessionID)
        if (taskStatus.retryAt != null) {
          scheduleSettledContinuation(sessionID, taskStatus.retryAt - Date.now(), scheduled != null)
        }
        return
      }
      if (busySessions.has(sessionID)) return
      if (latestStep) {
        const beforeProgress = await getGoalInternal(sessionID)
        const after = await recordAssistantProgress(sessionID, {
          messageID: latestStep.messageID,
          text: latestStep.text,
          outputTokens: latestStep.outputTokens,
          noProgressTokenThreshold: positiveIntegerOrNull(options.no_progress_token_threshold),
          maxNoProgressTurns: positiveIntegerOrNull(options.max_no_progress_turns),
          evaluateContinuation: true,
          completedAt: latestStep.completedAt,
        })
        await reconcileLocalMarkerAfterProgress(locallyDeliveredPendingSessions, sessionID, after)
        const progressed = Boolean(
          after &&
            (after.lastAssistantMessageID !== (beforeProgress?.lastAssistantMessageID ?? "") ||
              after.lastAssistantText !== (beforeProgress?.lastAssistantText ?? "")),
        )
        const queuedAfterProgress = scheduledContinuations.get(sessionID)
        if (progressed && queuedAfterProgress?.purpose !== "settle") cancelScheduledContinuation(sessionID)
      }
      if (scheduled && scheduledContinuations.get(sessionID) !== scheduled) return
      const current = await getGoalInternal(sessionID)
      if (!current) return
      const latestTurnAgent = latestStep?.agent
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

      // Pending-continuation resolution (same semantics as V1).
      const attempt = pendingAttemptOf(current)
      if (current.status === "active" && attempt != null) {
        const deliveredLocally = locallyDeliveredPendingSessions.has(sessionID)
        if (!pendingReadyForFailure(attempt, deliveredLocally)) {
          return
        }
        const afterFailure = await recordContinuationResult(sessionID, "failure", maxPromptFailures, {
          requirePending: true,
        })
        if (afterFailure) locallyDeliveredPendingSessions.delete(sessionID)
        if (autoContinue && afterFailure?.status === "active") {
          scheduleSettledContinuation(
            sessionID,
            continuationRetryDelayMs(minInterval, attempt.reservedAt),
            true,
            "retry",
          )
        }
        return
      }

      const queuedBeforeReserve = scheduledContinuations.get(sessionID)
      if (queuedBeforeReserve && queuedBeforeReserve !== scheduled) return
      if (!autoContinue) return
      if (nativeRetrySessions.has(sessionID)) return

      const goal = await reserveContinuation(sessionID, maxAutoTurns, minInterval)
      if (!goal) return
      attemptReservedAt = goal.pendingAttempt?.reservedAt ?? Date.now()
      if (nativeRetrySessions.has(sessionID)) {
        await rollbackContinuationAttempt(sessionID)
        return
      }
      if (scheduled && scheduledContinuations.get(sessionID) !== scheduled) {
        // Ownership of the scheduled continuation was lost (replaced or
        // canceled) while we reserved: roll the reserved turn back so it does
        // not consume an auto-turn.
        await rollbackContinuationAttempt(sessionID)
        return
      }
      await sendContinuation(
        sessionID,
        goal.status === "active" ? continuationPrompt(goal) : limitPrompt(goal),
        goal.lastPromptAgent ?? latestTurnAgent ?? null,
      )
      if (disposed) {
        await rollbackContinuationAttempt(sessionID)
        return
      }
      // Delivery succeeded, so commit the attempt even if the timer that
      // started it was canceled while the prompt was in flight. Rolling back
      // here would refund an accepted prompt and allow a duplicate on idle.
      const delivered = await recordContinuationResult(sessionID, "success", maxPromptFailures)
      locallyDeliveredPendingSessions.add(sessionID)
      if (!delivered?.pendingAttempt?.delivered) {
        await rollbackContinuationAttempt(sessionID)
      }
    } catch (error) {
      if (disposed) {
        // See the V1 catch block: torn down while the prompt was in flight, so
        // roll back the reserved undelivered attempt without counting a
        // transport failure or consuming an auto-turn.
        await rollbackContinuationAttempt(sessionID)
        return
      }
      if (isTransportError(error)) {
        const afterFailure = await recordContinuationResult(sessionID, "failure", maxPromptFailures)
        if (autoContinue && afterFailure?.status === "active") {
          scheduleSettledContinuation(
            sessionID,
            continuationRetryDelayMs(minInterval, attemptReservedAt),
            true,
            "retry",
          )
        }
      } else {
        await rollbackContinuationAttempt(sessionID)
      }
      v2ErrorLog("Auto-continue failed", error)
    } finally {
      activeContinuationsV2.delete(sessionID)
    }
  }

  async function handleV2Event(event: V2EventLike) {
    const data = event.data
    const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined
    switch (event.type) {
      case "session.created": {
        const parentID = data.parentID
        if (sessionID && typeof parentID === "string") {
          taskTracker.observeSessionCreated({ properties: { info: { id: sessionID, parentID } } })
        }
        return
      }
      case "session.status": {
        const status = data.status
        if (sessionID && isRecord(status) && typeof status.type === "string") {
          if (status.type === "busy") {
            busySessions.add(sessionID)
            nativeRetrySessions.delete(sessionID)
            armTurnWatchdog(sessionID)
            await markPendingContinuationStarted(sessionID)
          }
          if (status.type === "idle") {
            busySessions.delete(sessionID)
            nativeRetrySessions.delete(sessionID)
            clearTurnWatchdog(sessionID)
            watchdogRescuedSessions.delete(sessionID)
          }
          if (status.type === "retry") {
            nativeRetrySessions.add(sessionID)
            clearTurnWatchdog(sessionID)
            cancelScheduledContinuation(sessionID)
          }
          taskTracker.observeSessionStatus(sessionID, status.type)
          if (status.type === "idle") {
            // Even when auto-continue is disabled, a pending attempt must be
            // resolved on idle (no-response failures count exactly once, the
            // same as V1).
            const goal = await getGoalInternal(sessionID)
            if (autoContinue || goal?.pendingAttempt != null) await runAutoContinue(sessionID)
          }
        }
        return
      }
      case "session.idle": {
        if (sessionID) {
          busySessions.delete(sessionID)
          nativeRetrySessions.delete(sessionID)
          clearTurnWatchdog(sessionID)
          watchdogRescuedSessions.delete(sessionID)
          taskTracker.observeSessionStatus(sessionID, "idle")
        }
        if (sessionID) {
          // Resolution of a pending attempt runs even when auto-continue is
          // disabled (see the session.status idle branch above).
          const goal = await getGoalInternal(sessionID)
          if (autoContinue || goal?.pendingAttempt != null) await runAutoContinue(sessionID)
        }
        return
      }
      case "session.error": {
        if (!sessionID) return
        const inNativeRetry = nativeRetrySessions.has(sessionID)
        busySessions.delete(sessionID)
        clearTurnWatchdog(sessionID)
        // Same policy as V1: a native provider retry episode is already
        // recovering, so a transport error inside it must not schedule plugin
        // recovery, and the marker stays until busy/idle ends the episode.
        if (inNativeRetry) return
        nativeRetrySessions.delete(sessionID)
        watchdogRescuedSessions.delete(sessionID)
        const errorMessage = transportErrorMessageFromEvent(data)
        if (errorMessage && isTransportError(errorMessage)) {
          const goal = await getGoalInternal(sessionID)
          if (goal?.status === "active") {
            const attempt = pendingAttemptOf(goal)
            if (attempt != null) {
              const afterFailure = await recordContinuationResult(sessionID, "failure", maxPromptFailures, {
                requirePending: true,
              })
              if (afterFailure) locallyDeliveredPendingSessions.delete(sessionID)
              if (autoContinue && afterFailure?.status === "active") {
                scheduleSettledContinuation(
                  sessionID,
                  continuationRetryDelayMs(minInterval, attempt.reservedAt),
                  true,
                  "retry",
                )
              }
            } else if (autoContinue) {
              // No pending attempt: start the first bounded automatic recovery
              // without charging a phantom failure. Duplicate transport events
              // dedupe through the scheduled-continuation timer.
              scheduleSettledContinuation(
                sessionID,
                continuationDelayFromSnapshot(minInterval, goal.lastContinuationAt),
                false,
                "recovery",
              )
            }
          }
        }
        return
      }
      case "session.deleted": {
        if (!sessionID) return
        busySessions.delete(sessionID)
        clearTurnWatchdog(sessionID)
        watchdogRescuedSessions.delete(sessionID)
        locallyDeliveredPendingSessions.delete(sessionID)
        nativeRetrySessions.delete(sessionID)
        const scheduled = scheduledContinuations.get(sessionID)
        if (scheduled) clearTimeout(scheduled.timer)
        scheduledContinuations.delete(sessionID)
        taskDeferredSessions.delete(sessionID)
        clearToolAttemptsForSession(toolAttempts, sessionID)
        taskTracker.observeSessionDeleted(sessionID)
        latestStepBySession.delete(sessionID)
        stepTokenSums.delete(sessionID)
        for (const key of [...stepTextBuffers.keys()]) {
          if (key.startsWith(`${sessionID}\0`)) stepTextBuffers.delete(key)
        }
        return
      }
      case "session.agent.selected": {
        if (sessionID && typeof data.agent === "string") await recordPromptAgent(sessionID, data.agent)
        return
      }
      case "session.step.started": {
        if (!sessionID || typeof data.assistantMessageID !== "string") return
        const messageID = data.assistantMessageID
        const agent = typeof data.agent === "string" ? data.agent : undefined
        if (agent) await recordPromptAgent(sessionID, agent)
        taskTracker.observeAssistantMessage(sessionID, {
          info: { id: messageID, role: "assistant", time: { completed: event.created } },
        })
        if (!stepTextBuffers.has(stepKey(sessionID, messageID))) stepTextBuffers.set(stepKey(sessionID, messageID), "")
        latestStepBySession.set(sessionID, { messageID, agent, text: "", outputTokens: null, completedAt: event.created })
        return
      }
      case "session.text.delta": {
        if (sessionID && typeof data.assistantMessageID === "string" && typeof data.delta === "string") {
          const key = stepKey(sessionID, data.assistantMessageID)
          stepTextBuffers.set(key, (stepTextBuffers.get(key) ?? "") + data.delta)
        }
        return
      }
      case "session.text.ended": {
        if (sessionID && typeof data.assistantMessageID === "string" && typeof data.text === "string") {
          stepTextBuffers.set(stepKey(sessionID, data.assistantMessageID), data.text)
        }
        return
      }
      case "session.step.ended": {
        if (!sessionID || typeof data.assistantMessageID !== "string") return
        const messageID = data.assistantMessageID
        const tokens = tokensFromRecord(data.tokens)
        if (typeof tokens === "number") {
          const sum = (stepTokenSums.get(sessionID) ?? 0) + tokens
          stepTokenSums.set(sessionID, sum)
          await accountUsage(sessionID, sum, {
            cumulative: true,
            source: "v2.steps",
            initialBaseline: Math.ceil(sum - tokens),
          })
        }
        const text = stepTextBuffers.get(stepKey(sessionID, messageID)) ?? ""
        stepTextBuffers.delete(stepKey(sessionID, messageID))
        const outputTokens = outputTokensFromRecord(data.tokens) ?? null
        const afterStep = await recordAssistantProgress(sessionID, {
          messageID,
          text,
          outputTokens,
          noProgressTokenThreshold: positiveIntegerOrNull(options.no_progress_token_threshold),
          maxNoProgressTurns: positiveIntegerOrNull(options.max_no_progress_turns),
          completedAt: event.created,
        })
        await reconcileLocalMarkerAfterProgress(locallyDeliveredPendingSessions, sessionID, afterStep)
        // Substantive output from the model proves the transport recovered, so
        // any pending automatic recovery timer is no longer needed.
        if (/[\p{L}\p{N}]/u.test(text)) {
          const scheduled = scheduledContinuations.get(sessionID)
          if (scheduled?.purpose === "recovery") cancelScheduledContinuation(sessionID)
        }
        latestStepBySession.set(sessionID, {
          messageID,
          agent: latestStepBySession.get(sessionID)?.agent,
          text,
          outputTokens,
          completedAt: event.created,
        })
        return
      }
      case "session.step.failed": {
        if (!sessionID || typeof data.assistantMessageID !== "string") return
        const messageID = data.assistantMessageID
        const tokens = tokensFromRecord(data.tokens)
        if (typeof tokens === "number") {
          const sum = (stepTokenSums.get(sessionID) ?? 0) + tokens
          stepTokenSums.set(sessionID, sum)
          await accountUsage(sessionID, sum, {
            cumulative: true,
            source: "v2.steps",
            initialBaseline: Math.ceil(sum - tokens),
          })
        }
        const text = stepTextBuffers.get(stepKey(sessionID, messageID)) ?? ""
        stepTextBuffers.delete(stepKey(sessionID, messageID))
        const outputTokens = outputTokensFromRecord(data.tokens) ?? null
        const afterStep = await recordAssistantProgress(sessionID, {
          messageID,
          text,
          outputTokens,
          noProgressTokenThreshold: positiveIntegerOrNull(options.no_progress_token_threshold),
          maxNoProgressTurns: positiveIntegerOrNull(options.max_no_progress_turns),
          completedAt: event.created,
        })
        await reconcileLocalMarkerAfterProgress(locallyDeliveredPendingSessions, sessionID, afterStep)
        if (/[\p{L}\p{N}]/u.test(text)) {
          const scheduled = scheduledContinuations.get(sessionID)
          if (scheduled?.purpose === "recovery") cancelScheduledContinuation(sessionID)
        }
        latestStepBySession.set(sessionID, {
          messageID,
          agent: latestStepBySession.get(sessionID)?.agent,
          text,
          outputTokens,
          completedAt: event.created,
        })
        return
      }
      case "session.usage.updated": {
        if (!sessionID) return
        const tokens = tokensFromRecord(data.tokens)
        if (typeof tokens === "number") await accountUsage(sessionID, tokens, { cumulative: true, source: "v2.session" })
        return
      }
    }
  }

  if (registerCommand) {
    const existingCommands = new Set((await context.command.list()).data.map((command) => command.name))
    registrations.push(
      await context.command.transform((draft) => {
        const claimedCommands = new Set(existingCommands)
        for (const command of goalCommandDefinitions(commandName)) {
          if (claimedCommands.has(command.name)) continue
          claimedCommands.add(command.name)
          draft.add({
            name: command.name,
            description: command.description,
            execute: async (input) => {
              if (command.action === "pause") {
                const goal = await getGoal(input.sessionID)
                if (goal?.status === "active") await setGoalStatus(input.sessionID, "paused")
                cancelScheduledContinuation(input.sessionID)
                clearTurnWatchdog(input.sessionID)
              }
              const stripMention = <T extends { mention?: unknown }>({ mention: _mention, ...attachment }: T) => attachment
              await context.session.prompt({
                ...(command.action === "goal"
                  ? {
                      ...input.prompt,
                      files: input.prompt.files?.map(stripMention),
                      agents: input.prompt.agents?.map(stripMention),
                      skills: input.prompt.skills?.map(stripMention),
                    }
                  : {}),
                sessionID: input.sessionID,
                text: command.template.replaceAll("$ARGUMENTS", () => input.prompt.text.trim()),
                delivery: input.delivery,
              })
            },
          })
        }
      }),
    )
  }

  registrations.push(
    await context.tool.transform((draft) => {
      for (const tool of goalToolsV2(goalServices)) draft.add(tool)
    }),
  )

  registrations.push(
    await context.tool.hook("execute.before", async (input) => {
      taskTracker.noteTaskCall({ tool: input.tool, sessionID: input.sessionID, callID: input.id })
      const sessionID = typeof input.sessionID === "string" ? input.sessionID : undefined
      const callID = typeof input.id === "string" ? input.id : undefined
      if (sessionID && callID) {
        const goal = await getGoalInternal(sessionID)
        toolAttempts.set(toolAttemptKey(sessionID, callID), goal?.pendingAttempt?.id ?? null)
      }
    }),
  )

  registrations.push(
    await context.tool.hook("execute.after", async (input) => {
      const sessionID = typeof input.sessionID === "string" ? input.sessionID : undefined
      const callID = typeof input.id === "string" ? input.id : undefined
      const attemptKey = sessionID && callID ? toolAttemptKey(sessionID, callID) : undefined
      const expectedAttemptID = attemptKey ? toolAttempts.get(attemptKey) : undefined
      if (attemptKey) toolAttempts.delete(attemptKey)
      if (input.status !== "completed") return
      const text = textFromToolResult(input.result)
      taskTracker.noteTaskOutput(
        { tool: input.tool, sessionID: input.sessionID, callID: input.id },
        { output: textFromToolResult(input.result) },
      )
      // A successful tool output is real progress: it resolves any pending
      // continuation and clears the prompt-failure counter. This body is async
      // so recovery cancellation completes before any pending recovery timer.
      if (!sessionID || typeof input.tool !== "string") return
      if (NON_PROGRESS_TOOLS.has(input.tool.toLowerCase())) return
      if (toolOutputFailed(input.result)) return
      if (!text) return
      const before = await getGoalInternal(sessionID)
      const scheduled = scheduledContinuations.get(sessionID)
      const hasFailureEpisode = Boolean(
        before && (before.continuationFailures > 0 || before.pendingAttempt != null),
      )
      if (!before || (!hasFailureEpisode && scheduled?.purpose !== "recovery")) return
      const progressed = await recordToolProgress(sessionID, text, expectedAttemptID)
      if (progressed?.continuationFailures === 0 && progressed.pendingAttempt == null) {
        locallyDeliveredPendingSessions.delete(sessionID)
        cancelScheduledContinuation(sessionID)
      }
    }),
  )

  registrations.push(
    await context.session.hook("context", (sessionContext) => {
      const reminder = systemReminder()
      if (sessionContext.system.some((part) => part.type === "text" && part.text.includes(reminder))) return
      sessionContext.system.push({ type: "text", text: reminder })
    }),
  )

  const abortController = new AbortController()
  let eventIterator: AsyncIterator<unknown> | undefined
  const consumer = (async () => {
    const subscription = context.event.subscribe({ signal: abortController.signal })
    const iterator = subscription[Symbol.asyncIterator]()
    eventIterator = iterator
    try {
      while (true) {
        const { done, value } = await iterator.next()
        if (done) break
        const event = decodeV2Event(value)
        if (event) await handleV2Event(event)
      }
    } catch (error) {
      if (!abortController.signal.aborted) v2ErrorLog("V2 event consumer stopped", error)
    }
  })()

  return async () => {
    disposed = true
    abortController.abort()
    for (const scheduled of scheduledContinuations.values()) clearTimeout(scheduled.timer)
    scheduledContinuations.clear()
    for (const watchdog of turnWatchdogs.values()) clearTimeout(watchdog.timer)
    turnWatchdogs.clear()
    activeContinuationsV2.clear()
    nativeRetrySessions.clear()
    locallyDeliveredPendingSessions.clear()
    watchdogRescuedSessions.clear()
    toolAttempts.clear()
    for (const registration of registrations) await registration.dispose()
    // Best-effort termination of the event consumer. Never block plugin
    // unload on a stream that does not close promptly.
    const termination = Promise.allSettled([consumer, eventIterator?.return?.()])
    await Promise.race([termination, new Promise((resolve) => setTimeout(resolve, 2_000))])
  }
}

function goalToolsV2(services: GoalServices): ToolV2Info[] {
  return [
    {
      name: "get_goal",
      description:
        "Get the current goal for this OpenCode session, including status, observed token usage, elapsed-time usage, budgets, checkpoints, and history.",
      input: v2ObjectSchema({}),
      options: { codemode: false },
      execute: async (_args, toolContext) => ({
        content: await getGoalToolResult(await getGoal(toolContext.sessionID)),
      }),
    },
    {
      name: "get_goal_history",
      description: "Get the current goal lifecycle history and recent checkpoints for this OpenCode session.",
      input: v2ObjectSchema({}),
      options: { codemode: false },
      execute: async (_args, toolContext) => {
        const goal = await getGoal(toolContext.sessionID)
        return { content: JSON.stringify({ goal, history_report: formatGoalHistory(goal) }, null, 2) }
      },
    },
    {
      name: "list_all_goals",
      description:
        "List up to 50 public goal summaries across all sessions in this state file, ordered by most recently updated first. Elapsed time is the last persisted value; total and truncated report omitted older goals.",
      input: v2ObjectSchema({}),
      options: { codemode: false },
      execute: async () => ({
        content: JSON.stringify(await getAllGoals(), null, 2),
      }),
    },
    {
      name: "create_goal",
      description:
        "Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks. If any non-closed goal exists, this returns the existing goal as either reused or conflicting and must not be retried. While the session is in Plan mode, the goal is recorded as paused and execution requires the user to switch to Build mode.",
      input: v2ObjectSchema(
        {
          objective: { type: "string", minLength: 1, maxLength: 4000, description: "The concrete objective to start pursuing." },
          token_budget: { type: ["integer", "null"], minimum: 1, description: "Optional positive token budget." },
          max_auto_turns: { type: ["integer", "null"], minimum: 1, description: "Optional per-goal auto-continue limit." },
          max_duration_seconds: { type: ["integer", "null"], minimum: 1, description: "Optional per-goal duration limit." },
        },
        ["objective"],
      ),
      options: { codemode: false },
      execute: async (args, toolContext) => ({
        content: await createGoalFromTool(args as CreateGoalArgs, toolContext, services),
      }),
    },
    {
      name: "set_goal",
      description:
        "Set a new goal when the user explicitly asks the agent to formulate and set its own goal. The model should write the objective itself based on the user's explicit request. If any non-closed goal exists, this returns the existing goal as either reused or conflicting and must not be retried. While the session is in Plan mode, the goal is recorded as paused and execution requires the user to switch to Build mode.",
      input: v2ObjectSchema(
        {
          objective: {
            type: "string",
            minLength: 1,
            maxLength: 4000,
            description: "The model-formulated concrete objective to start pursuing.",
          },
          token_budget: { type: ["integer", "null"], minimum: 1, description: "Optional positive token budget." },
          max_auto_turns: { type: ["integer", "null"], minimum: 1, description: "Optional per-goal auto-continue limit." },
          max_duration_seconds: { type: ["integer", "null"], minimum: 1, description: "Optional per-goal duration limit." },
        },
        ["objective"],
      ),
      options: { codemode: false },
      execute: async (args, toolContext) => ({
        content: await createGoalFromTool(args as CreateGoalArgs, toolContext, services),
      }),
    },
    {
      name: "update_goal_objective",
      description: "Edit the current OpenCode goal objective when the user explicitly asks to edit or replace it.",
      input: v2ObjectSchema(
        {
          objective: { type: "string", minLength: 1, maxLength: 4000, description: "The updated concrete objective." },
          status: { type: "string", enum: ["active", "paused"], description: "Whether the edited goal should be active or paused." },
        },
        ["objective"],
      ),
      options: { codemode: false },
      execute: async (args, toolContext) => ({
        content: await updateGoalObjectiveFromTool(args as { objective: string; status?: "active" | "paused" }, toolContext, services),
      }),
    },
    {
      name: "update_goal",
      description:
        "Close the existing goal only after an audit against real evidence. Use status complete only when the objective is achieved and no required work remains, and include evidence. Use status unmet only when the objective cannot be achieved or is blocked, and include the blocker. Do not close a goal merely because work is stopping.",
      input: v2ObjectSchema(
        {
          status: {
            type: "string",
            enum: ["complete", "unmet"],
            description: "Required. complete means achieved; unmet means blocked or impossible.",
          },
          evidence: {
            type: "string",
            minLength: 1,
            maxLength: 4000,
            description: "Required when status is complete. Summarize the concrete evidence verified.",
          },
          blocker: {
            type: "string",
            minLength: 1,
            maxLength: 4000,
            description: "Required when status is unmet. Explain the concrete blocker or impossibility.",
          },
        },
        ["status"],
      ),
      options: { codemode: false },
      execute: async (args, toolContext) => ({
        content: await closeGoalFromTool(args as UpdateGoalArgs, toolContext),
      }),
    },
    {
      name: "update_goal_status",
      description:
        "Pause or resume the current OpenCode goal when the user explicitly asks to pause or resume it. Resuming is not allowed while the session is in Plan mode; the user must switch to Build mode first.",
      input: v2ObjectSchema(
        {
          status: {
            type: "string",
            enum: ["active", "paused"],
            description: "active resumes a goal; paused pauses it without clearing it.",
          },
        },
        ["status"],
      ),
      options: { codemode: false },
      execute: async (args, toolContext) => ({
        content: await updateGoalStatusFromTool(args as { status: "active" | "paused" }, toolContext, services),
      }),
    },
    {
      name: "clear_goal",
      description: "Clear the current OpenCode goal for this session when the user explicitly asks to clear it.",
      input: v2ObjectSchema({}),
      options: { codemode: false },
      execute: async (_args, toolContext) => ({
        content: JSON.stringify({ cleared: await clearGoal(toolContext.sessionID) }, null, 2),
      }),
    },
  ]
}

export default {
  id: "local.goal-mode.server",
  server,
  setup: setupV2,
}
