import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { mkdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { Data, Effect, Schema } from "effect"
import { atomicWriteFile } from "./atomic-write"

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
  evaluateContinuation?: boolean
  /** Millisecond completedAt of the assistant message, for correlating progress to the current attempt. */
  completedAt?: number | null
}

/**
 * A single automatic-continuation attempt. It is persisted BEFORE the prompt
 * is delivered so that out-of-band events (a session status "busy" that races
 * the prompt resolution) can correlate to the correct attempt instead of
 * relying on local-only function timing. The attempt is internal: it is never
 * exposed on the public GoalSnapshot / tool JSON.
 */
export type PendingAttempt = {
  /** Stable identity for the attempt, used to correlate busy/error/progress events. */
  id: string
  /** Millisecond timestamp used as the minimum-interval and staleness anchor. */
  reservedAt: number
  /** The provider picked the prompt up (a session.status busy fired). */
  started: boolean
  /** The prompt was confirmed delivered (promptAsync / session.prompt resolved). */
  delivered: boolean
  /** autoTurns / lastContinuationAt were committed for this attempt. */
  committed: boolean
  /** Whether the delivered prompt should arm the no-progress evaluation. */
  armNoProgress: boolean
  /** lastContinuationAt value to restore if this unconsumed attempt is rolled back. */
  previousLastContinuationAt: number | null
}

export type Goal = {
  sessionID: string
  objective: string
  status: GoalStatus
  tokenBudget: number | null
  tokensUsed: number
  usageTrackers: Record<string, UsageTracker>
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
  pendingAttempt: PendingAttempt | null
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
  awaitingContinuationProgress: boolean
  continuationBaselineMessageID: string
  continuationBaselineSummary: string
}

type UsageTracker = {
  baseline: number
  lastObserved: number
  baseTokens: number
  pendingBaseline: number | null
  pendingBaseTokens: number | null
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
const MAX_LISTED_GOALS = 50
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
const PendingAttemptSchema = Schema.Struct({
  id: Schema.String,
  reservedAt: Schema.Number,
  started: Schema.Boolean,
  delivered: Schema.Boolean,
  committed: Schema.Boolean,
  armNoProgress: Schema.Boolean,
  previousLastContinuationAt: Schema.NullOr(Schema.Number),
})
const UsageTrackerSchema = Schema.Struct({
  baseline: Schema.optionalWith(Schema.Unknown, { default: () => null }),
  lastObserved: Schema.optionalWith(Schema.Unknown, { default: () => null }),
  baseTokens: Schema.optionalWith(Schema.Unknown, { default: () => null }),
  pendingBaseline: Schema.optionalWith(Schema.Unknown, { default: () => null }),
  pendingBaseTokens: Schema.optionalWith(Schema.Unknown, { default: () => null }),
})
const GoalSchema = Schema.Struct({
  sessionID: Schema.String,
  objective: Schema.String,
  status: Schema.Literal("active", "paused", "budgetLimited", "usageLimited", "complete", "unmet"),
  tokenBudget: NullableNumber,
  tokensUsed: Schema.Number,
  usageTrackers: Schema.optionalWith(Schema.Record({ key: Schema.String, value: UsageTrackerSchema }), { default: () => ({}) }),
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
  pendingAttempt: Schema.optionalWith(Schema.NullOr(PendingAttemptSchema), { default: () => null }),
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
  awaitingContinuationProgress: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  continuationBaselineMessageID: Schema.optionalWith(Schema.String, { default: () => "" }),
  continuationBaselineSummary: Schema.optionalWith(Schema.String, { default: () => "" }),
})
const StateSchema = Schema.Struct({
  version: Schema.Literal(1),
  goals: Schema.Record({ key: Schema.String, value: GoalSchema }),
})

// The public snapshot omits internal transport-recovery fields. The internal
// continuation machinery (server and tests) reads them through
// getGoalInternal / the internal snapshot type instead.
export type GoalSnapshot = Omit<
  Goal,
  "lastAccountedAt" | "autoTurns" | "lastContinuationAt" | "pendingAttempt" | "usageTrackers"
> & {
  remainingTokens: number | null
  sampledAt: number
  autoTurns: number
  lastContinuationAt: number | null
}

/** Internal view of a goal with the pending-attempt lifecycle exposed. */
export type InternalGoalSnapshot = GoalSnapshot & {
  pendingAttempt: PendingAttempt | null
}

export type GoalListItem = Pick<
  Goal,
  | "sessionID"
  | "objective"
  | "status"
  | "tokenBudget"
  | "tokensUsed"
  | "timeUsedSeconds"
  | "createdAt"
  | "updatedAt"
  | "closedAt"
  | "maxAutoTurns"
  | "maxDurationSeconds"
  | "autoTurns"
  | "stopReason"
> & { remainingTokens: number | null }

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

const warnedEmptyStatePaths = new Set<string>()
export type StateRecoveryNotice = {
  stateFile: string
  quarantineFile: string
  outcome: "quarantined" | "quarantineFailed" | "sourceChanged"
  error?: string
}
type StateRecoveryListener = {
  stateFile: string
  report: (notice: StateRecoveryNotice) => Promise<void> | void
}
const stateRecoveryListeners = new Set<StateRecoveryListener>()

export function onStateRecovery(stateFile: string, report: StateRecoveryListener["report"]) {
  const listener = { stateFile, report }
  stateRecoveryListeners.add(listener)
  return () => stateRecoveryListeners.delete(listener)
}

function notifyStateRecovery(notice: StateRecoveryNotice) {
  for (const listener of stateRecoveryListeners) {
    if (listener.stateFile !== notice.stateFile) continue
    void Promise.resolve()
      .then(() => listener.report(notice))
      .catch((error) => {
        try {
          console.error(
            `[opencode-goal-plugin] Failed to report quarantined state at ${notice.quarantineFile}:`,
            error instanceof Error ? error.message : String(error),
          )
        } catch {
          // Reporting must never block state recovery.
        }
      })
  }
}

function isStatePadding(character: string) {
  return character === "\0" || character.trim() === ""
}

function parseStateText(raw: string, file: string) {
  // trim handles whitespace and UTF-8 BOMs. NUL padding can remain after an
  // interrupted filesystem write, so tolerate it only at the file boundaries.
  let start = 0
  let end = raw.length
  while (start < end && isStatePadding(raw[start]!)) start += 1
  while (end > start && isStatePadding(raw[end - 1]!)) end -= 1
  const content = raw.slice(start, end)
  if (content) return { value: JSON.parse(content) as unknown, recoveryContent: null }

  if (!warnedEmptyStatePaths.has(file)) {
    warnedEmptyStatePaths.add(file)
    console.warn(`[opencode-goal-plugin] Empty or zero-filled state file at ${file}; recovering with empty state.`)
  }
  return { value: emptyState(), recoveryContent: raw || null }
}

function decodeState(value: unknown) {
  return Schema.decodeUnknown(StateSchema)(value).pipe(
    Effect.map(mutableState),
    Effect.map(normalizeState),
    Effect.mapError((cause) => new StateDecodeError({ cause })),
  )
}

function readStateResultEffect(file = statePath()) {
  return Effect.tryPromise({
    try: () => readFile(file, "utf8"),
    catch: (cause) => new StateReadError({ cause }),
  }).pipe(
    Effect.flatMap((raw) =>
      Effect.try({
        try: () => parseStateText(raw, file),
        catch: (cause) => new StateDecodeError({ cause }),
      }),
    ),
    Effect.flatMap(({ value, recoveryContent }) =>
      decodeState(value).pipe(Effect.map((state) => ({ state, recoveryContent }))),
    ),
    Effect.catchAll((error) =>
      error._tag === "StateReadError" && isMissingStateFile(error.cause)
        ? Effect.succeed({ state: emptyState(), recoveryContent: null })
        : Effect.fail(error),
    ),
  )
}

function readStateEffect(file = statePath()) {
  return readStateResultEffect(file).pipe(Effect.map(({ state }) => state))
}

function quarantineStateEffect(file: string, content: string) {
  return Effect.promise(async () => {
    const quarantineFile = `${file}.corrupt-${Date.now()}-${randomUUID()}`
    try {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 })
      await atomicWriteFile(quarantineFile, content)
      return { quarantineFile, error: null }
    } catch (error) {
      return { quarantineFile, error: error instanceof Error ? error.message : String(error) }
    }
  })
}

function verifyRecoverySourceEffect(file: string, expectedContent: string, quarantineFile: string) {
  return Effect.promise(async () => {
    try {
      return (await readFile(file, "utf8")) === expectedContent
    } catch (error) {
      if (!isMissingStateFile(error)) {
        try {
          console.error(
            `[opencode-goal-plugin] Could not re-read ${file} after preserving it at ${quarantineFile}; continuing recovery:`,
            error instanceof Error ? error.message : String(error),
          )
        } catch {
          // Diagnostics must never block state recovery.
        }
      }
      return true
    }
  })
}

function writeStateEffect(state: State, file = statePath()) {
  return Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 })
      // atomicWriteFile writes to a same-directory temp file, fsyncs it, then
      // renames it into place: the final path is only ever replaced by a
      // fully-flushed file, so after a process or OS crash the state is the
      // old or the new valid version, never a torn or empty file. Ordinary
      // fsync improves crash consistency but is not `F_FULLFSYNC`, so sudden
      // power loss on macOS/APFS has no absolute durability guarantee. Where
      // the platform supports it, the parent directory is also fsync'd after
      // the rename so the rename itself survives a crash; where it does not
      // (Windows / some filesystems) the write still succeeds and a crash
      // leaves either the old or the new valid state, never a torn file.
      await atomicWriteFile(file, JSON.stringify(state, null, 2) + "\n")
    },
    catch: (cause) => new StateWriteError({ cause }),
  })
}

async function readState(): Promise<State> {
  return Effect.runPromise(readStateEffect())
}

function readStateSync(): State {
  try {
    const file = statePath()
    const raw = readFileSync(file, "utf8")
    return normalizeState(mutableState(Schema.decodeUnknownSync(StateSchema)(parseStateText(raw, file).value)))
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
  return enqueueMutation(() => {
    const file = statePath()
    return Effect.runPromise(
      Effect.gen(function* () {
        const { state, recoveryContent } = yield* readStateResultEffect(file)
        const result = yield* Effect.tryPromise({
          try: () => Promise.resolve(fn(state)),
          catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
        })
        if (recoveryContent != null) {
          const quarantine = yield* quarantineStateEffect(file, recoveryContent)
          if (quarantine.error != null) {
            const notice: StateRecoveryNotice = {
              stateFile: file,
              quarantineFile: quarantine.quarantineFile,
              outcome: "quarantineFailed",
              error: quarantine.error,
            }
            try {
              console.error(
                `[opencode-goal-plugin] Could not quarantine corrupt state at ${file}; continuing recovery:`,
                quarantine.error,
              )
            } catch {
              // Diagnostics must never block state recovery.
            }
            notifyStateRecovery(notice)
          } else {
            const unchanged = yield* verifyRecoverySourceEffect(file, recoveryContent, quarantine.quarantineFile)
            if (!unchanged) {
              const message = "goal state changed while recovery was being quarantined; refusing to overwrite it"
              notifyStateRecovery({
                stateFile: file,
                quarantineFile: quarantine.quarantineFile,
                outcome: "sourceChanged",
                error: message,
              })
              return yield* Effect.fail(new StateWriteError({ cause: new Error(message) }))
            }
            try {
              console.warn(
                `[opencode-goal-plugin] Preserved corrupt state from ${file} at ${quarantine.quarantineFile}; continuing recovery.`,
              )
            } catch {
              // Diagnostics must never block state recovery.
            }
            notifyStateRecovery({
              stateFile: file,
              quarantineFile: quarantine.quarantineFile,
              outcome: "quarantined",
            })
          }
        }
        yield* writeStateEffect(state, file)
        return result
      }),
    )
  })
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
  goal.awaitingContinuationProgress = goal.awaitingContinuationProgress === true
  goal.lastContinuationAt =
    typeof goal.lastContinuationAt === "number" && Number.isFinite(goal.lastContinuationAt)
      ? Math.floor(goal.lastContinuationAt >= 1_000_000_000_000 ? goal.lastContinuationAt / 1000 : goal.lastContinuationAt)
      : null
  goal.pendingAttempt = normalizePendingAttempt(goal.pendingAttempt)
  goal.continuationBaselineMessageID ??= ""
  goal.continuationBaselineSummary ??= ""
  goal.noProgressTurns = nonNegativeInteger(goal.noProgressTurns, 0)
  goal.maxAutoTurns = positiveIntegerOrNull(goal.maxAutoTurns)
  goal.maxDurationSeconds = positiveIntegerOrNull(goal.maxDurationSeconds)
  goal.tokenBudget = positiveIntegerOrNull(goal.tokenBudget)
  goal.usageTrackers = normalizeUsageTrackers(goal.usageTrackers)
  goal.noProgressTokenThreshold = positiveIntegerOrNull(goal.noProgressTokenThreshold) ?? DEFAULT_NO_PROGRESS_TOKEN_THRESHOLD
  goal.maxNoProgressTurns = positiveIntegerOrNull(goal.maxNoProgressTurns) ?? DEFAULT_MAX_NO_PROGRESS_TURNS
  goal.budgetWrapupSent = goal.budgetWrapupSent === true
  goal.stopReason ??= null
  return goal
}

function normalizeUsageTrackers(trackers: Record<string, UsageTracker> | undefined) {
  const normalized: Record<string, UsageTracker> = {}
  for (const [source, rawTracker] of Object.entries(trackers ?? {})) {
    const tracker = rawTracker as Partial<UsageTracker>
    const baseline = nonNegativeIntegerOrNull(tracker?.baseline)
    const lastObserved = nonNegativeIntegerOrNull(tracker?.lastObserved)
    const baseTokens = nonNegativeIntegerOrNull(tracker?.baseTokens)
    if (source && baseline != null && lastObserved != null && baseTokens != null && lastObserved >= baseline) {
      const pendingBaseline = nonNegativeIntegerOrNull(tracker.pendingBaseline)
      const pendingBaseTokens = nonNegativeIntegerOrNull(tracker.pendingBaseTokens)
      normalized[source] = {
        baseline,
        lastObserved,
        baseTokens,
        pendingBaseline,
        pendingBaseTokens: pendingBaseline == null ? null : pendingBaseTokens,
      }
    }
  }
  return normalized
}

function normalizePendingAttempt(attempt: PendingAttempt | null | undefined): PendingAttempt | null {
  if (!attempt || typeof attempt !== "object") return null
  return {
    id: typeof attempt.id === "string" && attempt.id ? attempt.id : randomId(),
    reservedAt:
      typeof attempt.reservedAt === "number" && Number.isFinite(attempt.reservedAt) ? attempt.reservedAt : Date.now(),
    started: attempt.started === true,
    delivered: attempt.delivered === true,
    committed: attempt.committed === true,
    armNoProgress: attempt.armNoProgress !== false,
    previousLastContinuationAt:
      typeof attempt.previousLastContinuationAt === "number" && Number.isFinite(attempt.previousLastContinuationAt)
        ? attempt.previousLastContinuationAt
        : null,
  }
}

function randomId() {
  return `att_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
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

function nonNegativeIntegerOrNull(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null
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
    awaitingContinuationProgress: goal.awaitingContinuationProgress,
    continuationBaselineMessageID: goal.continuationBaselineMessageID,
    continuationBaselineSummary: goal.continuationBaselineSummary,
    autoTurns: goal.autoTurns,
    lastContinuationAt: goal.lastContinuationAt,
    remainingTokens: remainingTokens(goal),
    sampledAt,
  }
}

export function snapshotInternal(goal: Goal): InternalGoalSnapshot {
  return { ...snapshot(goal), pendingAttempt: goal.pendingAttempt }
}

export async function getGoal(sessionID: string) {
  const state = await readState()
  const goal = state.goals[sessionID]
  return goal ? snapshot(goal) : null
}

export async function getAllGoals() {
  const state = await readState()
  const sorted = Object.values(state.goals).sort(
    (left, right) =>
      right.updatedAt - left.updatedAt || (left.sessionID < right.sessionID ? -1 : left.sessionID > right.sessionID ? 1 : 0),
  )
  const goals = sorted.slice(0, MAX_LISTED_GOALS).map(goalListItem)
  return { goals, total: sorted.length, truncated: sorted.length > goals.length }
}

function goalListItem(goal: Goal): GoalListItem {
  return {
    sessionID: goal.sessionID,
    objective: goal.objective,
    status: goal.status,
    tokenBudget: goal.tokenBudget,
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds: goal.timeUsedSeconds,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    closedAt: goal.closedAt ?? null,
    maxAutoTurns: goal.maxAutoTurns,
    maxDurationSeconds: goal.maxDurationSeconds,
    autoTurns: goal.autoTurns,
    stopReason: goal.stopReason,
    remainingTokens: remainingTokens(goal),
  }
}

export async function getGoalInternal(sessionID: string) {
  const state = await readState()
  const goal = state.goals[sessionID]
  return goal ? snapshotInternal(goal) : null
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
      usageTrackers: {},
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
      pendingAttempt: null,
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
      awaitingContinuationProgress: false,
      continuationBaselineMessageID: "",
      continuationBaselineSummary: "",
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
    if (goal.status === "active") {
      goal.continuationFailures = 0
      goal.pendingAttempt = null
      goal.awaitingContinuationProgress = false
    }
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
    goal.pendingAttempt = status === "active" ? null : goal.pendingAttempt
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

export async function accountUsage(
  sessionID: string,
  tokensUsed?: number,
  options?: { cumulative?: boolean; source?: string; initialBaseline?: number },
) {
  return mutate((state) => {
    const goal = state.goals[sessionID]
    if (!goal) return null
    accountWallClock(goal)
    if (typeof tokensUsed === "number" && Number.isFinite(tokensUsed)) {
      const observed = Math.max(0, Math.ceil(tokensUsed))
      if (options?.cumulative === true) {
        const source = options.source?.trim() || "default"
        let tracker = goal.usageTrackers[source]
        if (!tracker) {
          const initialBaseline = nonNegativeIntegerOrNull(options.initialBaseline)
          tracker =
            initialBaseline != null && initialBaseline <= observed
              ? {
                  baseline: initialBaseline,
                  lastObserved: observed,
                  baseTokens: goal.tokensUsed,
                  pendingBaseline: null,
                  pendingBaseTokens: null,
                }
              : {
                  baseline: observed,
                  lastObserved: observed,
                  baseTokens: goal.tokensUsed,
                  pendingBaseline: null,
                  pendingBaseTokens: null,
                }
          goal.usageTrackers[source] = tracker
        } else if (observed < tracker.lastObserved) {
          const initialBaseline = nonNegativeIntegerOrNull(options.initialBaseline)
          if (initialBaseline != null && initialBaseline <= observed) {
            tracker = {
              baseline: initialBaseline,
              lastObserved: observed,
              baseTokens: goal.tokensUsed,
              pendingBaseline: null,
              pendingBaseTokens: null,
            }
            goal.usageTrackers[source] = tracker
          } else if (tracker.pendingBaseline == null || observed < tracker.pendingBaseline) {
            // Require a second consistent low observation before treating an
            // un-signaled decrease as compaction rather than a partial sample.
            tracker.pendingBaseline = observed
            tracker.pendingBaseTokens = goal.tokensUsed
          } else {
            tracker = {
              baseline: tracker.pendingBaseline,
              lastObserved: observed,
              baseTokens: tracker.pendingBaseTokens ?? goal.tokensUsed,
              pendingBaseline: null,
              pendingBaseTokens: null,
            }
            goal.usageTrackers[source] = tracker
          }
        } else {
          tracker.lastObserved = observed
          tracker.pendingBaseline = null
          tracker.pendingBaseTokens = null
        }
        goal.tokensUsed = Math.max(goal.tokensUsed, tracker.baseTokens + observed - tracker.baseline)
      } else {
        goal.tokensUsed = Math.max(goal.tokensUsed, observed)
      }
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
    const substantive = /[\p{L}\p{N}]/u.test(text)
    const previousSummary = summarizeText(goal.lastAssistantText)
    const repeatedMessage = Boolean(messageID && messageID === goal.lastAssistantMessageID)
    const changed = Boolean(summary && summary !== previousSummary)

    if (summary && (!repeatedMessage || changed)) recordCheckpoint(goal, summary)
    if (text) goal.lastAssistantText = text
    if (messageID) goal.lastAssistantMessageID = messageID

    // Substantive assistant text proves the continuation transport is healthy,
    // so a pending continuation is resolved and any accumulated prompt failures
    // are cleared. Delivery of a prompt alone never resets the counter.
    if (substantive && summary && (!repeatedMessage || changed)) {
      // Correlate the progress to the current attempt: delayed output that
      // completed before this attempt was reserved belongs to a prior turn and
      // must not clear a newer pending attempt. Guarded by the attempt's
      // reservedAt anchor (ms). Without a timestamp we resolve conservatively.
      const attempt = goal.pendingAttempt
      if (attempt == null || input.completedAt == null || input.completedAt >= attempt.reservedAt) {
        goal.continuationFailures = 0
        goal.pendingAttempt = null
      }
    }

    // No-progress accounting is scoped to goal continuation turns: it only runs
    // once per reserved continuation, when the completed turn is observed at the
    // next idle. Generic observation paths (messages.transform, message.updated)
    // record checkpoints above but never touch the counter.
    const attemptForCompletion = goal.pendingAttempt
    const continuationTurnCompleted =
      input.evaluateContinuation === true &&
      goal.awaitingContinuationProgress &&
      Boolean(messageID) &&
      messageID !== goal.continuationBaselineMessageID &&
      // The turn must belong to (complete at/after) the current attempt; a
      // delayed prior-turn message must not consume the evaluation.
      (input.completedAt == null || attemptForCompletion == null || input.completedAt >= attemptForCompletion.reservedAt)
    if (continuationTurnCompleted) {
      goal.awaitingContinuationProgress = false
      goal.pendingAttempt = null
      const lowOutput = outputTokens > 0 && outputTokens < (threshold ?? DEFAULT_NO_PROGRESS_TOKEN_THRESHOLD)
      const changedSinceContinuation = Boolean(summary && summary !== goal.continuationBaselineSummary)
      if (lowOutput && !changedSinceContinuation) {
        goal.noProgressTurns += 1
        if (maxNoProgressTurns && goal.noProgressTurns >= maxNoProgressTurns) {
          accountWallClock(goal)
          goal.status = "paused"
          goal.lastAccountedAt = null
          goal.stopReason = "no progress"
          goal.blocker = `Auto-continue paused after ${goal.noProgressTurns} low-progress continuation turn(s). Resume the goal to retry.`
          goal.lastStatus = goal.blocker
          pushHistory(goal, "warning", goal.blocker)
        } else {
          goal.lastStatus = `Low-progress continuation turn detected (${goal.noProgressTurns}/${maxNoProgressTurns ?? "unbounded"}).`
          pushHistory(goal, "warning", goal.lastStatus)
        }
      } else {
        goal.noProgressTurns = 0
      }
    }

    goal.updatedAt = nowSeconds()
    return snapshot(goal)
  })
}

/**
 * Persist the next automatic continuation attempt BEFORE the prompt is
 * delivered so that a racing session.status "busy" can correlate to this exact
 * attempt. The autoTurn and lastContinuationAt are committed immediately here
 * (the attempt is a reserved turn); if the attempt is later canceled before it
 * is actually sent, callers must roll it back with rollbackContinuationAttempt.
 */
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
    const previousLastContinuationAt = goal.lastContinuationAt
    goal.lastContinuationAt = now
    // The baseline is captured at reservation time, but the no-progress
    // evaluation is only armed once recordContinuationResult confirms the
    // continuation prompt was actually delivered.
    goal.continuationBaselineMessageID = goal.lastAssistantMessageID
    goal.continuationBaselineSummary = summarizeText(goal.lastAssistantText)
    goal.pendingAttempt = {
      id: randomId(),
      reservedAt: Date.now(),
      started: false,
      delivered: false,
      committed: true,
      armNoProgress: true,
      previousLastContinuationAt,
    }
    goal.awaitingContinuationProgress = false
    goal.lastStatus = `Auto-continue ${goal.autoTurns} reserved.`
    pushHistory(goal, "autoContinue", goal.lastStatus)
    goal.updatedAt = now
    return snapshotInternal(goal)
  })
}

/**
 * Roll back a reserved-but-not-delivered attempt: it must not consume an
 * autoTurn or lastContinuationAt because it was canceled before the prompt was
 * actually sent (e.g. a native retry, a dispose, or a plan/task deferral that
 * short-circuited before delivery). Returns true if a committed attempt was
 * rolled back.
 */
export async function rollbackContinuationAttempt(sessionID: string) {
  return mutate((state) => {
    const goal = state.goals[sessionID]
    if (!goal) return false
    const attempt = goal.pendingAttempt
    if (!attempt || attempt.delivered || !attempt.committed) {
      if (attempt && !attempt.delivered) goal.pendingAttempt = null
      return false
    }
    goal.autoTurns = Math.max(0, goal.autoTurns - 1)
    goal.lastContinuationAt = attempt.previousLastContinuationAt
    goal.pendingAttempt = null
    goal.awaitingContinuationProgress = false
    goal.lastStatus = "Auto-continue attempt canceled before delivery."
    goal.updatedAt = nowSeconds()
    return true
  })
}

export async function recordContinuationResult(
  sessionID: string,
  result: "success" | "failure",
  maxFailures: number,
  options?: { armNoProgress?: boolean; started?: boolean; requirePending?: boolean },
) {
  return mutate((state) => {
    const goal = state.goals[sessionID]
    if (!goal || isClosed(goal.status)) return goal ? snapshotInternal(goal) : null
    const now = nowSeconds()
    goal.updatedAt = now
    if (result === "success") {
      // Successful delivery commits the reserved attempt (it was armed before
      // delivery so a racing busy already correlated to it). Delivery alone is
      // not "started": a session.status busy event marks it started through
      // markPendingContinuationStarted. Watchdog rescues deliver while already
      // busy and pass started: true.
      if (goal.status === "active") {
        const attempt = goal.pendingAttempt
        if (attempt) {
          attempt.delivered = true
          // Preserve a started flag set by a busy that raced the delivery.
          attempt.started = attempt.started || options?.started === true
          attempt.armNoProgress = options?.armNoProgress ?? attempt.armNoProgress
          if (attempt.armNoProgress) goal.awaitingContinuationProgress = true
        } else {
          // No reserved attempt (a watchdog rescue or a direct success call):
          // arm a delivered untracked attempt so the pending window still
          // works. It consumed no autoTurn (committed: false), so rollback
          // treats it as unconsumed.
          goal.pendingAttempt = {
            id: randomId(),
            reservedAt: Date.now(),
            started: options?.started === true,
            delivered: true,
            committed: false,
            armNoProgress: options?.armNoProgress !== false,
            previousLastContinuationAt: goal.lastContinuationAt,
          }
          if (goal.pendingAttempt.armNoProgress) goal.awaitingContinuationProgress = true
        }
        goal.lastStatus = "Auto-continue prompt sent."
      }
      return snapshotInternal(goal)
    }
    // Failure: only transport / unresolved no-response attempts count toward the
    // ceiling. requirePending ensures a failure without a pending attempt (e.g.
    // a stray duplicate transport event) is not double-counted.
    if (options?.requirePending && goal.pendingAttempt == null) return null
    goal.continuationFailures += 1
    goal.awaitingContinuationProgress = false
    goal.pendingAttempt = null
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
    return snapshotInternal(goal)
  })
}

export async function markPendingContinuationStarted(sessionID: string) {
  // Fast-path read: only a busy event for an active goal with an unstarted
  // pending attempt warrants a state write. Goal-less or already-started busy
  // events must not create or rewrite the state file.
  const state = await readState()
  const current = state.goals[sessionID]
  if (!current || current.status !== "active") return current ? snapshotInternal(current) : null
  if (current.pendingAttempt == null || current.pendingAttempt.started) return snapshotInternal(current)
  return mutate((state) => {
    const goal = state.goals[sessionID]
    if (!goal || goal.status !== "active") return goal ? snapshotInternal(goal) : null
    if (goal.pendingAttempt == null || goal.pendingAttempt.started) return snapshotInternal(goal)
    goal.pendingAttempt.started = true
    goal.updatedAt = nowSeconds()
    return snapshotInternal(goal)
  })
}

/**
 * Record successful tool output as progress. The optional `expectedAttemptID`
 * is the pending-attempt id captured when the tool call started: when it is
 * provided (a string, or `null` when no attempt was pending then), a currently
 * pending attempt is only cleared when it matches, so delayed output from an
 * earlier turn can never clear a newer pending attempt. Omitting the argument
 * keeps the legacy unconditional reset for direct callers.
 */
export async function recordToolProgress(sessionID: string, text?: string, expectedAttemptID?: string | null) {
  return mutate((state) => {
    const goal = state.goals[sessionID]
    if (!goal || goal.status !== "active") return goal ? snapshotInternal(goal) : null
    const value = text?.trim() ?? ""
    if (!value) return snapshotInternal(goal)
    if (goal.continuationFailures === 0 && goal.pendingAttempt == null) return snapshotInternal(goal)
    // A tool call that started before the current attempt was reserved may
    // finish while a newer attempt is pending. Its output belongs to the prior
    // turn, so it must not clear the newer attempt: only clear when the
    // captured attempt matches, or when nothing is pending to protect.
    if (goal.pendingAttempt != null && expectedAttemptID !== undefined && expectedAttemptID !== goal.pendingAttempt.id) {
      return snapshotInternal(goal)
    }
    // A successful tool output is real progress for the transport: it resolves
    // any pending continuation and clears the prompt-failure counter. It MUST
    // NOT touch the continuation no-progress evaluation (awaitingContinuationProgress
    // and noProgressTurns): a tool call that runs during a continuation turn
    // must not reset the low-output accounting that the assistant's final text
    // still needs to drive. Failed tool outputs never reach this reset.
    goal.continuationFailures = 0
    goal.pendingAttempt = null
    goal.updatedAt = nowSeconds()
    return snapshotInternal(goal)
  })
}

function reserveWrapup(goal: Goal): InternalGoalSnapshot | null {
  if (goal.budgetWrapupSent) return null
  goal.budgetWrapupSent = true
  goal.updatedAt = nowSeconds()
  pushHistory(goal, "limited", `${goal.status}: ${goal.stopReason ?? "goal limit reached"}; requested final handoff.`)
  return snapshotInternal(goal)
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
