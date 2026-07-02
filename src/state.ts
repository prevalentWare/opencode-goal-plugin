import { readFileSync } from "node:fs"
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { Data, Effect, Schema } from "effect"

export type GoalStatus = "active" | "paused" | "budgetLimited" | "usageLimited" | "complete" | "unmet"
export type MutableGoalStatus = "active" | "paused"
export type GoalHistoryType =
  | "created"
  | "updated"
  | "paused"
  | "resumed"
  | "completed"
  | "unmet"
  | "autoContinue"
  | "checkpoint"
  | "warning"
  | "limited"
  | "error"

export type GoalHistoryEntry = {
  type: GoalHistoryType
  detail: string
  timestamp: number
}

export type GoalCheckpoint = {
  summary: string
  timestamp: number
}

export type CreateGoalOptions = {
  tokenBudget?: number | null
  maxAutoTurns?: number | null
  maxDurationSeconds?: number | null
  noProgressTokenThreshold?: number | null
  maxNoProgressTurns?: number | null
  agent?: string | null
  initialStatus?: MutableGoalStatus
}

export type AssistantProgressInput = {
  messageID?: string
  text?: string
  outputTokens?: number | null
  noProgressTokenThreshold?: number | null
  maxNoProgressTurns?: number | null
}

export type Goal = {
  sessionID: string
  objective: string
  status: GoalStatus
  tokenBudget: number | null
  tokensUsed: number
  timeUsedSeconds: number
  createdAt: number
  updatedAt: number
  completionEvidence?: string | null
  blocker?: string | null
  closedAt?: number | null
  lastAccountedAt: number | null
  autoTurns: number
  lastContinuationAt: number | null
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
  lastPromptAgent: string | null
}

type State = {
  version: 1
  goals: Record<string, Goal>
}

class StateReadError extends Data.TaggedError("StateReadError")<{
  readonly cause: unknown
}> {}

class StateDecodeError extends Data.TaggedError("StateDecodeError")<{
  readonly cause: unknown
}> {}

class StateWriteError extends Data.TaggedError("StateWriteError")<{
  readonly cause: unknown
}> {}

const MAX_HISTORY_ENTRIES = 50
const MAX_CHECKPOINTS = 8
const CHECKPOINT_CHAR_LIMIT = 280
const DEFAULT_NO_PROGRESS_TOKEN_THRESHOLD = 50
const DEFAULT_MAX_NO_PROGRESS_TURNS = 2
export const PLAN_MODE_STOP_REASON = "plan mode"
export const PLAN_MODE_BLOCKER =
  "Goal execution is paused while the session is in Plan mode. Switch to Build mode and resume the goal to continue."
const NullableString = Schema.NullOr(Schema.String)
const NullableNumber = Schema.NullOr(Schema.Number)
const HistoryEntrySchema = Schema.Struct({
  type: Schema.Literal(
    "created",
    "updated",
    "paused",
    "resumed",
    "completed",
    "unmet",
    "autoContinue",
    "checkpoint",
    "warning",
    "limited",
    "error",
  ),
  detail: Schema.String,
  timestamp: Schema.Number,
})
const CheckpointSchema = Schema.Struct({
  summary: Schema.String,
  timestamp: Schema.Number,
})
const GoalSchema = Schema.Struct({
  sessionID: Schema.String,
  objective: Schema.String,
  status: Schema.Literal("active", "paused", "budgetLimited", "usageLimited", "complete", "unmet"),
  tokenBudget: NullableNumber,
  tokensUsed: Schema.Number,
  timeUsedSeconds: Schema.Number,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  completionEvidence: Schema.optionalWith(NullableString, { default: () => null }),
  blocker: Schema.optionalWith(NullableString, { default: () => null }),
  closedAt: Schema.optionalWith(NullableNumber, { default: () => null }),
  lastAccountedAt: NullableNumber,
  autoTurns: Schema.Number,
  lastContinuationAt: NullableNumber,
  continuationFailures: Schema.optionalWith(Schema.Number, { default: () => 0 }),
  lastStatus: Schema.optionalWith(NullableString, { default: () => null }),
  maxAutoTurns: Schema.optionalWith(NullableNumber, { default: () => null }),
  maxDurationSeconds: Schema.optionalWith(NullableNumber, { default: () => null }),
  noProgressTokenThreshold: Schema.optionalWith(NullableNumber, { default: () => DEFAULT_NO_PROGRESS_TOKEN_THRESHOLD }),
  maxNoProgressTurns: Schema.optionalWith(NullableNumber, { default: () => DEFAULT_MAX_NO_PROGRESS_TURNS }),
  noProgressTurns: Schema.optionalWith(Schema.Number, { default: () => 0 }),
  budgetWrapupSent: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  stopReason: Schema.optionalWith(NullableString, { default: () => null }),
  history: Schema.optionalWith(Schema.Array(HistoryEntrySchema), { default: () => [] }),
  checkpoints: Schema.optionalWith(Schema.Array(CheckpointSchema), { default: () => [] }),
  lastCheckpoint: Schema.optionalWith(Schema.NullOr(CheckpointSchema), { default: () => null }),
  lastAssistantText: Schema.optionalWith(Schema.String, { default: () => "" }),
  lastAssistantMessageID: Schema.optionalWith(Schema.String, { default: () => "" }),
  lastPromptAgent: Schema.optionalWith(NullableString, { default: () => null }),
})
const StateSchema = Schema.Struct({
  version: Schema.Literal(1),
  goals: Schema.Record({ key: Schema.String, value: GoalSchema }),
})

export type GoalSnapshot = Omit<Goal, "lastAccountedAt" | "autoTurns" | "lastContinuationAt"> & {
  remainingTokens: number | null
  sampledAt: number
  autoTurns: number
  lastContinuationAt: number | null
}

function defaultStateFile() {
  const dataHome =
    process.env.XDG_DATA_HOME ||
    (process.platform === "win32" && process.env.APPDATA ? process.env.APPDATA : join(homedir(), ".local", "share"))
  return join(dataHome, "opencode-goal-plugin", "goals.json")
}

export function statePath() {
  return process.env.OPENCODE_GOAL_STATE_PATH || defaultStateFile()
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000)
}

function emptyState(): State {
  return { version: 1, goals: {} }
}

function isMissingStateFile(error: unknown) {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT"
}

function mutableState(state: Schema.Schema.Type<typeof StateSchema>): State {
  return JSON.parse(JSON.stringify(state)) as State
}

function decodeState(value: unknown) {
  return Schema.decodeUnknown(StateSchema)(value).pipe(
    Effect.map(mutableState),
    Effect.map(normalizeState),
    Effect.mapError((cause) => new StateDecodeError({ cause })),
  )
}

function readStateEffect() {
  return Effect.tryPromise({
    try: () => readFile(statePath(), "utf8"),
    catch: (cause) => new StateReadError({ cause }),
  }).pipe(
    Effect.flatMap((raw) =>
      Effect.try({
        try: () => JSON.parse(raw) as unknown,
        catch: (cause) => new StateDecodeError({ cause }),
      }),
    ),
    Effect.flatMap(decodeState),
    Effect.catchAll((error) =>
      error._tag === "StateReadError" && isMissingStateFile(error.cause) ? Effect.succeed(emptyState()) : Effect.fail(error),
    ),
  )
}

function writeStateEffect(state: State) {
  return Effect.tryPromise({
    try: async () => {
      const file = statePath()
      await mkdir(dirname(file), { recursive: true, mode: 0o700 })
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
      await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 })
      await rename(tmp, file)
      await chmod(file, 0o600).catch(() => undefined)
    },
    catch: (cause) => new StateWriteError({ cause }),
  })
}

async function readState(): Promise<State> {
  return Effect.runPromise(readStateEffect())
}

function readStateSync(): State {
  try {
    const raw = readFileSync(statePath(), "utf8")
    return normalizeState(mutableState(Schema.decodeUnknownSync(StateSchema)(JSON.parse(raw) as unknown)))
  } catch (error) {
    if (isMissingStateFile(error)) return emptyState()
    throw error
  }
}

let mutationQueue: Promise<void> = Promise.resolve()

function enqueueMutation<T>(operation: () => Promise<T>) {
  const current = mutationQueue.then(operation, operation)
  mutationQueue = current.then(
    () => undefined,
    () => undefined,
  )
  return current
}

async function mutate<T>(fn: (state: State) => T | Promise<T>) {
  return enqueueMutation(() =>
    Effect.runPromise(
      Effect.gen(function* () {
        const state = yield* readStateEffect()
        const result = yield* Effect.tryPromise({
          try: () => Promise.resolve(fn(state)),
          catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
        })
        yield* writeStateEffect(state)
        return result
      }),
    ),
  )
}

export function validateObjective(objective: string) {
  const value = objective.trim()
  if (!value) throw new Error("goal objective must not be empty")
  if ([...value].length > 4000) throw new Error("goal objective must be at most 4000 characters")
  return value
}

export function validateEvidence(evidence: string | null | undefined, label: string) {
  const value = evidence?.trim()
  if (!value) throw new Error(`${label} must not be empty`)
  if ([...value].length > 4000) throw new Error(`${label} must be at most 4000 characters`)
  return value
}

function normalizeState(state: State): State {
  for (const goal of Object.values(state.goals)) normalizeGoal(goal)
  return state
}

function normalizeGoal(goal: Goal) {
  goal.history = (goal.history ?? []).slice(-MAX_HISTORY_ENTRIES)
  goal.checkpoints = (goal.checkpoints ?? []).slice(-MAX_CHECKPOINTS)
  goal.lastCheckpoint = goal.lastCheckpoint ?? goal.checkpoints.at(-1) ?? null
  goal.lastAssistantText ??= ""
  goal.lastAssistantMessageID ??= ""
  goal.lastPromptAgent ??= null
  goal.noProgressTurns = nonNegativeInteger(goal.noProgressTurns, 0)
  goal.maxAutoTurns = positiveIntegerOrNull(goal.maxAutoTurns)
  goal.maxDurationSeconds = positiveIntegerOrNull(goal.maxDurationSeconds)
  goal.tokenBudget = positiveIntegerOrNull(goal.tokenBudget)
  goal.noProgressTokenThreshold = positiveIntegerOrNull(goal.noProgressTokenThreshold) ?? DEFAULT_NO_PROGRESS_TOKEN_THRESHOLD
  goal.maxNoProgressTurns = positiveIntegerOrNull(goal.maxNoProgressTurns) ?? DEFAULT_MAX_NO_PROGRESS_TURNS
  goal.budgetWrapupSent = goal.budgetWrapupSent === true
  goal.stopReason ??= null
  return goal
}

function normalizeCreateOptions(input?: number | null | CreateGoalOptions): Required<CreateGoalOptions> {
  if (typeof input === "number" || input === null) {
    return {
      tokenBudget: positiveIntegerOrNull(input),
      maxAutoTurns: null,
      maxDurationSeconds: null,
      noProgressTokenThreshold: DEFAULT_NO_PROGRESS_TOKEN_THRESHOLD,
      maxNoProgressTurns: DEFAULT_MAX_NO_PROGRESS_TURNS,
      agent: null,
      initialStatus: "active",
    }
  }
  return {
    tokenBudget: positiveIntegerOrNull(input?.tokenBudget),
    maxAutoTurns: positiveIntegerOrNull(input?.maxAutoTurns),
    maxDurationSeconds: positiveIntegerOrNull(input?.maxDurationSeconds),
    noProgressTokenThreshold: positiveIntegerOrNull(input?.noProgressTokenThreshold) ?? DEFAULT_NO_PROGRESS_TOKEN_THRESHOLD,
    maxNoProgressTurns: positiveIntegerOrNull(input?.maxNoProgressTurns) ?? DEFAULT_MAX_NO_PROGRESS_TURNS,
    agent: typeof input?.agent === "string" && input.agent.trim() ? input.agent.trim() : null,
    initialStatus: input?.initialStatus === "paused" ? "paused" : "active",
  }
}

function positiveIntegerOrNull(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null
}

function nonNegativeInteger(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

function isClosed(status: GoalStatus) {
  return status === "complete" || status === "unmet"
}

function canContinue(status: GoalStatus) {
  return status === "active"
}

function remainingTokens(goal: Goal) {
  return goal.tokenBudget == null ? null : Math.max(0, goal.tokenBudget - goal.tokensUsed)
}

export function snapshot(goal: Goal): GoalSnapshot {
  normalizeGoal(goal)
  const sampledAt = nowSeconds()
  const activeSeconds =
    goal.status === "active" && goal.lastAccountedAt != null ? Math.max(0, sampledAt - goal.lastAccountedAt) : 0
  const timeUsedSeconds = goal.timeUsedSeconds + activeSeconds
  return {
    sessionID: goal.sessionID,
    objective: goal.objective,
    status: goal.status,
    tokenBudget: goal.tokenBudget,
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    completionEvidence: goal.completionEvidence ?? null,
    blocker: goal.blocker ?? null,
    closedAt: goal.closedAt ?? null,
    continuationFailures: goal.continuationFailures,
    lastStatus: goal.lastStatus,
    maxAutoTurns: goal.maxAutoTurns,
    maxDurationSeconds: goal.maxDurationSeconds,
    noProgressTokenThreshold: goal.noProgressTokenThreshold,
    maxNoProgressTurns: goal.maxNoProgressTurns,
    noProgressTurns: goal.noProgressTurns,
    budgetWrapupSent: goal.budgetWrapupSent,
    stopReason: goal.stopReason,
    history: goal.history,
    checkpoints: goal.checkpoints,
    lastCheckpoint: goal.lastCheckpoint,
    lastAssistantText: goal.lastAssistantText,
    lastAssistantMessageID: goal.lastAssistantMessageID,
    lastPromptAgent: goal.lastPromptAgent,
    autoTurns: goal.autoTurns,
    lastContinuationAt: goal.lastContinuationAt,
    remainingTokens: remainingTokens(goal),
    sampledAt,
  }
}

export async function getGoal(sessionID: string) {
  const state = await readState()
  const goal = state.goals[sessionID]
  return goal ? snapshot(goal) : null
}

export function getGoalSync(sessionID: string) {
  const state = readStateSync()
  const goal = state.goals[sessionID]
  return goal ? snapshot(goal) : null
}

export async function createGoal(sessionID: string, objective: string, options?: number | null | CreateGoalOptions) {
  const value = validateObjective(objective)
  const normalizedOptions = normalizeCreateOptions(options)
  return mutate((state) => {
    const existing = state.goals[sessionID]
    if (existing && !isClosed(existing.status)) {
      throw new Error("cannot create a new goal because this session already has a non-closed goal")
    }
    const now = nowSeconds()
    const paused = normalizedOptions.initialStatus === "paused"
    const goal: Goal = {
      sessionID,
      objective: value,
      status: normalizedOptions.initialStatus,
      tokenBudget: normalizedOptions.tokenBudget,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: now,
      updatedAt: now,
      completionEvidence: null,
      blocker: paused ? PLAN_MODE_BLOCKER : null,
      closedAt: null,
      lastAccountedAt: paused ? null : now,
      autoTurns: 0,
      lastContinuationAt: null,
      continuationFailures: 0,
      lastStatus: paused ? "Goal recorded from Plan mode; execution paused until resumed from Build mode." : "Goal set.",
      maxAutoTurns: normalizedOptions.maxAutoTurns,
      maxDurationSeconds: normalizedOptions.maxDurationSeconds,
      noProgressTokenThreshold: normalizedOptions.noProgressTokenThreshold,
      maxNoProgressTurns: normalizedOptions.maxNoProgressTurns,
      noProgressTurns: 0,
      budgetWrapupSent: false,
      stopReason: paused ? PLAN_MODE_STOP_REASON : null,
      history: [],
      checkpoints: [],
      lastCheckpoint: null,
      lastAssistantText: "",
      lastAssistantMessageID: "",
      lastPromptAgent: normalizedOptions.agent,
    }
    pushHistory(goal, "created", goalLimitSummary(goal))
    if (paused) pushHistory(goal, "paused", goal.lastStatus)
    state.goals[sessionID] = goal
    return snapshot(goal)
  })
}

export async function updateGoalObjective(
  sessionID: string,
  objective: string,
  status: MutableGoalStatus = "active",
  options?: { agent?: string | null; planModePause?: boolean },
) {
  const value = validateObjective(objective)
  const agent = typeof options?.agent === "string" && options.agent.trim() ? options.agent.trim() : null
  const planModePause = options?.planModePause === true
  return mutate((state) => {
    const goal = state.goals[sessionID]
    if (!goal) throw new Error("cannot update goal because this session has no goal")
    accountWallClock(goal)
    goal.objective = value
    goal.status = planModePause ? "paused" : status
    goal.updatedAt = nowSeconds()
    goal.lastAccountedAt = goal.status === "active" ? goal.updatedAt : null
    goal.completionEvidence = null
    goal.blocker = planModePause ? PLAN_MODE_BLOCKER : null
    goal.closedAt = null
    goal.stopReason = planModePause ? PLAN_MODE_STOP_REASON : null
    goal.budgetWrapupSent = false
    if (agent) goal.lastPromptAgent = agent
    goal.lastStatus = planModePause
      ? "Goal objective updated; execution paused while the session is in Plan mode."
      : goal.status === "active"
        ? "Goal objective updated and resumed."
        : "Goal objective updated and paused."
    pushHistory(goal, "updated", `Goal objective updated: ${summarizeText(value, 400)}`)
    if (planModePause) pushHistory(goal, "paused", goal.lastStatus)
    return snapshot(goal)
  })
}

export async function recordPromptAgent(sessionID: string, agent: string) {
  const value = agent.trim()
  if (!value) return null
  return mutate((state) => {
    const goal = state.goals[sessionID]
    if (!goal || isClosed(goal.status)) return goal ? snapshot(goal) : null
    if (goal.lastPromptAgent === value) return snapshot(goal)
    goal.lastPromptAgent = value
    goal.updatedAt = nowSeconds()
    return snapshot(goal)
  })
}

export async function pauseGoalForPlanMode(sessionID: string) {
  return mutate((state) => {
    const goal = state.goals[sessionID]
    if (!goal || goal.status !== "active") return goal ? snapshot(goal) : null
    accountWallClock(goal)
    goal.status = "paused"
    goal.lastAccountedAt = null
    goal.stopReason = PLAN_MODE_STOP_REASON
    goal.blocker = PLAN_MODE_BLOCKER
    goal.lastStatus = "Auto-continue paused while the session is in Plan mode."
    goal.updatedAt = nowSeconds()
    pushHistory(goal, "paused", goal.lastStatus)
    return snapshot(goal)
  })
}

export async function setGoalStatus(sessionID: string, status: MutableGoalStatus, agent?: string | null) {
  const agentValue = typeof agent === "string" && agent.trim() ? agent.trim() : null
  return mutate((state) => {
    const goal = state.goals[sessionID]
    if (!goal) throw new Error("cannot update goal because this session has no goal")
    accountWallClock(goal)
    goal.status = status
    goal.updatedAt = nowSeconds()
    goal.lastAccountedAt = status === "active" ? goal.updatedAt : null
    goal.continuationFailures = status === "active" ? 0 : goal.continuationFailures
    goal.noProgressTurns = status === "active" ? 0 : goal.noProgressTurns
    goal.stopReason = status === "active" ? null : "paused"
    goal.budgetWrapupSent = status === "active" ? false : goal.budgetWrapupSent
    goal.blocker = status === "active" ? null : goal.blocker
    if (agentValue) goal.lastPromptAgent = agentValue
    goal.lastStatus = status === "active" ? "Goal resumed." : "Goal paused."
    pushHistory(goal, status === "active" ? "resumed" : "paused", goal.lastStatus)
    return snapshot(goal)
  })
}

export async function closeGoal(
  sessionID: string,
  input:
    | {
        status: "complete"
        evidence: string
      }
    | {
        status: "unmet"
        blocker: string
      },
) {
  return mutate((state) => {
    const goal = state.goals[sessionID]
    if (!goal) throw new Error("cannot update goal because this session has no goal")
    accountWallClock(goal)
    const now = nowSeconds()
    goal.status = input.status
    goal.updatedAt = now
    goal.closedAt = now
    goal.lastAccountedAt = null
    goal.stopReason = input.status === "complete" ? null : "blocked"
    if (input.status === "complete") {
      goal.completionEvidence = validateEvidence(input.evidence, "completion evidence")
      goal.blocker = null
      goal.lastStatus = "Goal completed."
      pushHistory(goal, "completed", goal.completionEvidence)
    } else {
      goal.blocker = validateEvidence(input.blocker, "blocker")
      goal.completionEvidence = null
      goal.lastStatus = "Goal marked unmet."
      pushHistory(goal, "unmet", goal.blocker)
    }
    return snapshot(goal)
  })
}

export async function completeGoal(sessionID: string, evidence: string) {
  return closeGoal(sessionID, { status: "complete", evidence })
}

export async function markGoalUnmet(sessionID: string, blocker: string) {
  return closeGoal(sessionID, { status: "unmet", blocker })
}

export async function clearGoal(sessionID: string) {
  return mutate((state) => {
    const existed = Boolean(state.goals[sessionID])
    delete state.goals[sessionID]
    return existed
  })
}

export async function accountUsage(sessionID: string, tokensUsed?: number) {
  return mutate((state) => {
    const goal = state.goals[sessionID]
    if (!goal) return null
    accountWallClock(goal)
    if (typeof tokensUsed === "number" && Number.isFinite(tokensUsed)) {
      goal.tokensUsed = Math.max(goal.tokensUsed, Math.max(0, Math.ceil(tokensUsed)))
    }
    maybeStopForBudget(goal)
    goal.updatedAt = nowSeconds()
    return snapshot(goal)
  })
}

export async function recordAssistantProgress(sessionID: string, input: AssistantProgressInput) {
  return mutate((state) => {
    const goal = state.goals[sessionID]
    if (!goal || goal.status !== "active") return goal ? snapshot(goal) : null

    const text = input.text?.trim() ?? ""
    const messageID = input.messageID?.trim() ?? ""
    const outputTokens = positiveIntegerOrNull(input.outputTokens) ?? 0
    const threshold = positiveIntegerOrNull(input.noProgressTokenThreshold) ?? goal.noProgressTokenThreshold
    const maxNoProgressTurns = positiveIntegerOrNull(input.maxNoProgressTurns) ?? goal.maxNoProgressTurns
    const summary = summarizeText(text)
    const previousSummary = summarizeText(goal.lastAssistantText)
    const repeatedMessage = Boolean(messageID && messageID === goal.lastAssistantMessageID)
    const changed = Boolean(summary && summary !== previousSummary)

    if (summary && (!repeatedMessage || changed)) recordCheckpoint(goal, summary)
    if (text) goal.lastAssistantText = text
    if (messageID) goal.lastAssistantMessageID = messageID

    const lowOutput = outputTokens > 0 && outputTokens < (threshold ?? DEFAULT_NO_PROGRESS_TOKEN_THRESHOLD)
    const stalled = lowOutput && (repeatedMessage || !changed)
    if (stalled) {
      goal.noProgressTurns += 1
      if (maxNoProgressTurns && goal.noProgressTurns >= maxNoProgressTurns) {
        accountWallClock(goal)
        goal.status = "paused"
        goal.lastAccountedAt = null
        goal.stopReason = "no progress"
        goal.blocker = `Auto-continue paused after ${goal.noProgressTurns} low-progress turn(s). Resume the goal to retry.`
        goal.lastStatus = goal.blocker
        pushHistory(goal, "warning", goal.blocker)
      } else {
        goal.lastStatus = `Low-progress turn detected (${goal.noProgressTurns}/${maxNoProgressTurns ?? "unbounded"}).`
        pushHistory(goal, "warning", goal.lastStatus)
      }
    } else if (changed || outputTokens >= (threshold ?? DEFAULT_NO_PROGRESS_TOKEN_THRESHOLD)) {
      goal.noProgressTurns = 0
    }

    goal.updatedAt = nowSeconds()
    return snapshot(goal)
  })
}

export async function reserveContinuation(sessionID: string, maxAutoTurns: number, minIntervalSeconds: number) {
  return mutate((state) => {
    const goal = state.goals[sessionID]
    if (!goal) return null
    if (goal.status === "budgetLimited" || goal.status === "usageLimited") return reserveWrapup(goal)
    if (!canContinue(goal.status)) return null
    const now = nowSeconds()
    accountWallClock(goal, now)
    if (maybeStopForUsageLimit(goal, maxAutoTurns, now)) return reserveWrapup(goal)
    if (goal.lastContinuationAt && now - goal.lastContinuationAt < minIntervalSeconds) return null
    goal.autoTurns += 1
    goal.lastContinuationAt = now
    goal.lastStatus = `Auto-continue ${goal.autoTurns} reserved.`
    pushHistory(goal, "autoContinue", goal.lastStatus)
    goal.updatedAt = now
    return snapshot(goal)
  })
}

export async function recordContinuationResult(sessionID: string, result: "success" | "failure", maxFailures: number) {
  return mutate((state) => {
    const goal = state.goals[sessionID]
    if (!goal || isClosed(goal.status)) return goal ? snapshot(goal) : null
    const now = nowSeconds()
    goal.updatedAt = now
    if (result === "success") {
      goal.continuationFailures = 0
      if (goal.status === "active") goal.lastStatus = "Auto-continue prompt sent."
      return snapshot(goal)
    }
    goal.continuationFailures += 1
    goal.lastStatus = `Auto-continue failed ${goal.continuationFailures} time(s).`
    pushHistory(goal, "error", goal.lastStatus)
    if (goal.continuationFailures >= maxFailures) {
      accountWallClock(goal, now)
      goal.status = "paused"
      goal.lastAccountedAt = null
      goal.stopReason = "auto-continue failures"
      goal.lastStatus = `Paused after ${goal.continuationFailures} auto-continue failure(s).`
      goal.blocker = "Auto-continue prompt failed repeatedly. Resume the goal to retry."
      pushHistory(goal, "paused", goal.lastStatus)
    }
    return snapshot(goal)
  })
}

function reserveWrapup(goal: Goal) {
  if (goal.budgetWrapupSent) return null
  goal.budgetWrapupSent = true
  goal.updatedAt = nowSeconds()
  pushHistory(goal, "limited", `${goal.status}: ${goal.stopReason ?? "goal limit reached"}; requested final handoff.`)
  return snapshot(goal)
}

function maybeStopForBudget(goal: Goal) {
  if (goal.status !== "active") return
  if (goal.tokenBudget == null || goal.tokensUsed < goal.tokenBudget) return
  accountWallClock(goal)
  goal.status = "budgetLimited"
  goal.lastAccountedAt = null
  goal.stopReason = `token budget reached (${goal.tokensUsed}/${goal.tokenBudget})`
  goal.lastStatus = `${goal.stopReason}; wrap-up required.`
  pushHistory(goal, "limited", goal.lastStatus)
}

function maybeStopForUsageLimit(goal: Goal, defaultMaxAutoTurns: number, now = nowSeconds()) {
  if (goal.status !== "active") return false
  const effectiveMaxAutoTurns = goal.maxAutoTurns ?? defaultMaxAutoTurns
  if (effectiveMaxAutoTurns > 0 && goal.autoTurns >= effectiveMaxAutoTurns) {
    goal.status = "usageLimited"
    goal.lastAccountedAt = null
    goal.stopReason = `max auto-continues reached (${effectiveMaxAutoTurns})`
    goal.lastStatus = `${goal.stopReason}; wrap-up required.`
    pushHistory(goal, "limited", goal.lastStatus)
    return true
  }
  if (goal.maxDurationSeconds != null && goal.timeUsedSeconds >= goal.maxDurationSeconds) {
    goal.status = "usageLimited"
    goal.lastAccountedAt = null
    goal.stopReason = `max duration reached (${goal.maxDurationSeconds}s)`
    goal.lastStatus = `${goal.stopReason}; wrap-up required.`
    pushHistory(goal, "limited", goal.lastStatus)
    goal.updatedAt = now
    return true
  }
  return false
}

function accountWallClock(goal: Goal, now = nowSeconds()) {
  if (goal.status !== "active") return
  if (goal.lastAccountedAt == null) {
    goal.lastAccountedAt = now
    return
  }
  goal.timeUsedSeconds += Math.max(0, now - goal.lastAccountedAt)
  goal.lastAccountedAt = now
}

function recordCheckpoint(goal: Goal, summary: string) {
  const checkpoint = { summary: summarizeText(summary), timestamp: nowSeconds() }
  if (!checkpoint.summary || goal.lastCheckpoint?.summary === checkpoint.summary) return
  goal.lastCheckpoint = checkpoint
  goal.checkpoints = [...goal.checkpoints, checkpoint].slice(-MAX_CHECKPOINTS)
  pushHistory(goal, "checkpoint", checkpoint.summary)
}

function pushHistory(goal: Goal, type: GoalHistoryType, detail: string | null | undefined) {
  const value = summarizeText(detail ?? "", 400)
  if (!value) return
  goal.history = [...goal.history, { type, detail: value, timestamp: nowSeconds() }].slice(-MAX_HISTORY_ENTRIES)
}

function summarizeText(text: string, limit = CHECKPOINT_CHAR_LIMIT) {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (!normalized) return ""
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}...` : normalized
}

function goalLimitSummary(goal: Goal) {
  const limits = [
    goal.tokenBudget == null ? null : `${goal.tokenBudget} token budget`,
    goal.maxAutoTurns == null ? null : `${goal.maxAutoTurns} auto-continue limit`,
    goal.maxDurationSeconds == null ? null : `${goal.maxDurationSeconds}s duration limit`,
  ].filter(Boolean)
  return limits.length ? `Goal set with ${limits.join(", ")}.` : "Goal set with default continuation limits."
}

export function estimateTokensFromText(text: string) {
  return Math.ceil(text.length / 4)
}

export function formatGoal(goal: GoalSnapshot | null) {
  if (!goal) return "No goal is set for this session."
  const lines = [
    `Objective: ${goal.objective}`,
    `Status: ${goal.status}`,
    `Time used: ${goal.timeUsedSeconds}s`,
    `Tokens used: ${goal.tokensUsed}${goal.tokenBudget == null ? "" : `/${goal.tokenBudget}`}`,
    `Auto-continues: ${goal.autoTurns}${goal.maxAutoTurns == null ? "" : `/${goal.maxAutoTurns}`}`,
  ]
  if (goal.remainingTokens != null) lines.push(`Tokens remaining: ${goal.remainingTokens}`)
  if (goal.maxDurationSeconds != null) lines.push(`Duration limit: ${goal.maxDurationSeconds}s`)
  if (goal.noProgressTurns > 0) lines.push(`No-progress turns: ${goal.noProgressTurns}`)
  if (goal.lastCheckpoint) lines.push(`Latest checkpoint: ${goal.lastCheckpoint.summary}`)
  if (goal.lastStatus) lines.push(`Last status: ${goal.lastStatus}`)
  if (goal.stopReason) lines.push(`Stop reason: ${goal.stopReason}`)
  if (goal.completionEvidence) lines.push(`Completion evidence: ${goal.completionEvidence}`)
  if (goal.blocker) lines.push(`Blocker: ${goal.blocker}`)
  return lines.join("\n")
}

export function formatGoalHistory(goal: GoalSnapshot | null) {
  if (!goal) return "No goal history is available for this session."
  if (goal.history.length === 0) return "No goal history recorded yet."
  return goal.history.map((entry) => `- [${new Date(entry.timestamp * 1000).toISOString()}] ${entry.type}: ${entry.detail}`).join("\n")
}
