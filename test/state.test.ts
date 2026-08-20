import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  accountUsage,
  clearGoal,
  completeGoal,
  createGoal,
  markPendingContinuationStarted,
  recordAssistantProgress,
  getGoal,
  getGoalInternal,
  markGoalUnmet,
  pauseGoalForPlanMode,
  recordContinuationResult,
  recordPromptAgent,
  recordToolProgress,
  reserveContinuation,
  rollbackContinuationAttempt,
  setGoalStatus,
  updateGoalObjective,
} from "../src/state"

let dir = ""

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "opencode-goal-plugin-"))
  process.env.OPENCODE_GOAL_STATE_PATH = join(dir, "goals.json")
})

afterEach(async () => {
  delete process.env.OPENCODE_GOAL_STATE_PATH
  await rm(dir, { recursive: true, force: true })
})

test("creates, reads, pauses, resumes, completes, and clears a goal", async () => {
  const created = await createGoal("ses_1", "ship the plugin", 100)
  expect(created.status).toBe("active")
  expect(created.tokenBudget).toBe(100)
  expect(created.remainingTokens).toBe(100)
  expect(created.sampledAt).toBeGreaterThanOrEqual(created.createdAt)

  await accountUsage("ses_1", 40)
  expect((await getGoal("ses_1"))?.tokensUsed).toBe(40)

  expect((await setGoalStatus("ses_1", "paused")).status).toBe("paused")
  expect((await setGoalStatus("ses_1", "active")).status).toBe("active")
  const completed = await completeGoal("ses_1", "tests passed")
  expect(completed.status).toBe("complete")
  expect(completed.completionEvidence).toBe("tests passed")
  expect(await clearGoal("ses_1")).toBe(true)
  expect(await getGoal("ses_1")).toBeNull()
})

test("marks a goal unmet with a blocker and allows a new goal afterward", async () => {
  await createGoal("ses_1", "ship the plugin", 100)
  const unmet = await markGoalUnmet("ses_1", "missing external credentials")

  expect(unmet.status).toBe("unmet")
  expect(unmet.blocker).toBe("missing external credentials")

  const next = await createGoal("ses_1", "ship follow-up", null)
  expect(next.status).toBe("active")
  expect(next.objective).toBe("ship follow-up")
})

test("requires evidence when closing goals", async () => {
  await createGoal("ses_1", "ship the plugin", 100)
  await expect(completeGoal("ses_1", "")).rejects.toThrow("completion evidence must not be empty")
  await expect(markGoalUnmet("ses_1", "")).rejects.toThrow("blocker must not be empty")
})

test("token usage marks goals budget limited", async () => {
  await createGoal("ses_1", "stay active", 10)
  const updated = await accountUsage("ses_1", 12)
  expect(updated?.status).toBe("budgetLimited")
  expect(updated?.remainingTokens).toBe(0)
  expect(updated?.tokensUsed).toBe(12)
  expect(updated?.stopReason).toContain("token budget reached")
})

test("reserves continuation until max auto turns is reached", async () => {
  await createGoal("ses_1", "continue", null)
  expect(await reserveContinuation("ses_1", 1, 0)).not.toBeNull()
  const limited = await reserveContinuation("ses_1", 1, 0)
  expect(limited?.status).toBe("usageLimited")
  expect(limited?.budgetWrapupSent).toBe(true)
  expect(await reserveContinuation("ses_1", 1, 0)).toBeNull()
  expect((await getGoal("ses_1"))?.status).toBe("usageLimited")
})

test("generic assistant observations record checkpoints but never pause the goal", async () => {
  await createGoal("ses_1", "continue", { noProgressTokenThreshold: 50, maxNoProgressTurns: 2 })
  const first = await recordAssistantProgress("ses_1", { messageID: "m1", text: "Inspected the repo", outputTokens: 10 })
  expect(first?.lastCheckpoint?.summary).toBe("Inspected the repo")
  expect(first?.status).toBe("active")

  await recordAssistantProgress("ses_1", { messageID: "m2", text: "Checked PTY status", outputTokens: 15 })
  const observed = await recordAssistantProgress("ses_1", { messageID: "m3", text: "Checked PTY status", outputTokens: 15 })

  expect(observed?.status).toBe("active")
  expect(observed?.noProgressTurns).toBe(0)
  expect(observed?.history.some((entry) => entry.type === "checkpoint")).toBe(true)
})

test("no-progress pause only counts goal continuation turns", async () => {
  await createGoal("ses_1", "continue", { noProgressTokenThreshold: 50, maxNoProgressTurns: 2 })
  await recordAssistantProgress("ses_1", { messageID: "m0", text: "Working on it", outputTokens: 100 })

  await reserveContinuation("ses_1", 10, 0)
  await recordContinuationResult("ses_1", "success", 3)
  const firstStall = await recordAssistantProgress("ses_1", {
    messageID: "m1",
    text: "Working on it",
    outputTokens: 10,
    evaluateContinuation: true,
  })
  expect(firstStall?.noProgressTurns).toBe(1)
  expect(firstStall?.status).toBe("active")

  await reserveContinuation("ses_1", 10, 0)
  await recordContinuationResult("ses_1", "success", 3)
  const paused = await recordAssistantProgress("ses_1", {
    messageID: "m2",
    text: "Working on it",
    outputTokens: 10,
    evaluateContinuation: true,
  })
  expect(paused?.status).toBe("paused")
  expect(paused?.stopReason).toBe("no progress")
  expect(paused?.blocker).toContain("continuation turn")
})

test("progressing continuation turns reset the no-progress counter", async () => {
  await createGoal("ses_1", "continue", { noProgressTokenThreshold: 50, maxNoProgressTurns: 2 })
  await recordAssistantProgress("ses_1", { messageID: "m0", text: "Working on it", outputTokens: 100 })

  await reserveContinuation("ses_1", 10, 0)
  await recordContinuationResult("ses_1", "success", 3)
  await recordAssistantProgress("ses_1", { messageID: "m1", text: "Working on it", outputTokens: 10, evaluateContinuation: true })

  await reserveContinuation("ses_1", 10, 0)
  await recordContinuationResult("ses_1", "success", 3)
  const progressed = await recordAssistantProgress("ses_1", {
    messageID: "m2",
    text: "Implemented the parser and added passing tests",
    outputTokens: 400,
    evaluateContinuation: true,
  })

  expect(progressed?.noProgressTurns).toBe(0)
  expect(progressed?.status).toBe("active")
})

test("generic observations during a continuation turn do not consume the evaluation", async () => {
  await createGoal("ses_1", "continue", { noProgressTokenThreshold: 50, maxNoProgressTurns: 2 })
  await recordAssistantProgress("ses_1", { messageID: "m0", text: "Working on it", outputTokens: 100 })
  await reserveContinuation("ses_1", 10, 0)
  await recordContinuationResult("ses_1", "success", 3)

  const observed = await recordAssistantProgress("ses_1", { messageID: "m1", text: "Working on it", outputTokens: 10 })
  expect(observed?.noProgressTurns).toBe(0)
  expect(observed?.awaitingContinuationProgress).toBe(true)

  const evaluated = await recordAssistantProgress("ses_1", {
    messageID: "m1",
    text: "Working on it",
    outputTokens: 10,
    evaluateContinuation: true,
  })
  expect(evaluated?.noProgressTurns).toBe(1)
  expect(evaluated?.awaitingContinuationProgress).toBe(false)
})

test("failed continuation sends do not arm no-progress evaluation", async () => {
  await createGoal("ses_1", "continue", { noProgressTokenThreshold: 50, maxNoProgressTurns: 2 })
  await recordAssistantProgress("ses_1", { messageID: "m0", text: "Checking status", outputTokens: 100 })

  const reserved = await reserveContinuation("ses_1", 10, 0)
  expect(reserved?.awaitingContinuationProgress).toBe(false)

  const failed = await recordContinuationResult("ses_1", "failure", 3)
  expect(failed?.awaitingContinuationProgress).toBe(false)

  const observed = await recordAssistantProgress("ses_1", {
    messageID: "m_user_response",
    text: "Checking status",
    outputTokens: 10,
    evaluateContinuation: true,
  })
  expect(observed?.noProgressTurns).toBe(0)
  expect(observed?.status).toBe("active")
})

test("creates a paused planning goal and records the prompting agent", async () => {
  const created = await createGoal("ses_1", "implement the feature", { agent: "plan", initialStatus: "paused" })

  expect(created.status).toBe("paused")
  expect(created.lastPromptAgent).toBe("plan")
  expect(created.stopReason).toBe("plan mode")
  expect(created.blocker).toContain("Build mode")
  expect(created.history.some((entry) => entry.type === "paused")).toBe(true)

  const resumed = await setGoalStatus("ses_1", "active", "build")
  expect(resumed.status).toBe("active")
  expect(resumed.stopReason).toBeNull()
  expect(resumed.lastPromptAgent).toBe("build")
})

test("plan-mode pause via objective update keeps the plan-mode reason", async () => {
  await createGoal("ses_1", "implement the feature", { agent: "plan", initialStatus: "paused" })
  const updated = await updateGoalObjective("ses_1", "implement the feature safely", "paused", {
    agent: "plan",
    planModePause: true,
  })

  expect(updated.status).toBe("paused")
  expect(updated.stopReason).toBe("plan mode")
  expect(updated.blocker).toContain("Build mode")
  expect(updated.lastPromptAgent).toBe("plan")
})

test("records the last prompting agent and pauses active goals for plan mode", async () => {
  const created = await createGoal("ses_1", "keep going", { agent: "build" })
  expect(created.status).toBe("active")
  expect(created.lastPromptAgent).toBe("build")

  const recorded = await recordPromptAgent("ses_1", "plan")
  expect(recorded?.lastPromptAgent).toBe("plan")

  const paused = await pauseGoalForPlanMode("ses_1")
  expect(paused?.status).toBe("paused")
  expect(paused?.stopReason).toBe("plan mode")
  expect(paused?.blocker).toContain("Build mode")

  expect((await pauseGoalForPlanMode("ses_1"))?.status).toBe("paused")
})

test("decodes persisted goal state with optional closure fields omitted", async () => {
  await writeFile(
    process.env.OPENCODE_GOAL_STATE_PATH!,
    JSON.stringify({
      version: 1,
      goals: {
        ses_1: {
          sessionID: "ses_1",
          objective: "continue",
          status: "active",
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 1,
          updatedAt: 1,
          lastAccountedAt: 1,
          autoTurns: 0,
          lastContinuationAt: null,
        },
      },
    }),
  )

  const goal = await getGoal("ses_1")

  expect(goal?.completionEvidence).toBeNull()
  expect(goal?.blocker).toBeNull()
  expect(goal?.closedAt).toBeNull()
  expect(goal?.lastPromptAgent).toBeNull()
})

test("writes state with owner-only file permissions", async () => {
  await createGoal("ses_1", "ship the plugin", null)

  const mode = (await stat(process.env.OPENCODE_GOAL_STATE_PATH!)).mode & 0o777

  expect(mode).toBe(0o600)
})

test("does not overwrite corrupt persisted state", async () => {
  await writeFile(process.env.OPENCODE_GOAL_STATE_PATH!, "{not valid json", "utf8")

  await expect(createGoal("ses_1", "ship the plugin", null)).rejects.toThrow()

  expect(await readFile(process.env.OPENCODE_GOAL_STATE_PATH!, "utf8")).toBe("{not valid json")
})

test("prompt delivery arms the pending window but never resets the failure count", async () => {
  await createGoal("ses_1", "keep going", null)
  await reserveContinuation("ses_1", 10, 0)
  await recordContinuationResult("ses_1", "failure", 5)
  await recordContinuationResult("ses_1", "failure", 5)

  const delivered = await recordContinuationResult("ses_1", "success", 5)
  expect(delivered?.continuationFailures).toBe(2)
  expect(delivered?.pendingAttempt).not.toBeNull()
  expect(delivered?.pendingAttempt?.started).toBe(false)
  expect(delivered?.awaitingContinuationProgress).toBe(true)

  const failed = await recordContinuationResult("ses_1", "failure", 5)
  expect(failed?.continuationFailures).toBe(3)
  expect(failed?.pendingAttempt).toBeNull()
  expect(failed?.awaitingContinuationProgress).toBe(false)
})

test("a session busy event marks the pending attempt as started", async () => {
  await createGoal("ses_1", "keep going", null)
  await reserveContinuation("ses_1", 10, 0)
  await recordContinuationResult("ses_1", "success", 5)
  expect((await getGoalInternal("ses_1"))?.pendingAttempt?.started).toBe(false)

  const started = await markPendingContinuationStarted("ses_1")
  expect(started?.pendingAttempt?.started).toBe(true)

  // Marking an already-started or absent attempt is idempotent.
  const again = await markPendingContinuationStarted("ses_1")
  expect(again?.pendingAttempt?.started).toBe(true)
  await recordContinuationResult("ses_1", "failure", 5)
  expect((await markPendingContinuationStarted("ses_1"))?.pendingAttempt).toBeNull()
})

test("markPendingContinuationStarted on a goal-less busy event does not create state", async () => {
  // No goal exists for this session, so a busy event must not create a state
  // file nor rewrite anything.
  expect(await markPendingContinuationStarted("ses_nogoal")).toBeNull()
  await expect(readFile(process.env.OPENCODE_GOAL_STATE_PATH!, "utf8")).rejects.toThrow()
})

test("markPendingContinuationStarted does not rewrite state when nothing is pending", async () => {
  await createGoal("ses_1", "keep going", null)
  await markPendingContinuationStarted("ses_1")
  const mtime = (await stat(process.env.OPENCODE_GOAL_STATE_PATH!)).mtimeMs

  // A busy with no pending attempt (or an already-started one) must be a
  // read-only no-op and must not rewrite the state file.
  await markPendingContinuationStarted("ses_1")
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect((await stat(process.env.OPENCODE_GOAL_STATE_PATH!)).mtimeMs).toBe(mtime)
})

test("persists continuation failures and the pending window across restart", async () => {
  await createGoal("ses_1", "keep going", null)
  await reserveContinuation("ses_1", 10, 0)
  await recordContinuationResult("ses_1", "success", 5)
  await recordContinuationResult("ses_1", "failure", 5)
  await recordContinuationResult("ses_1", "failure", 5)

  // getGoalInternal re-reads the persisted state file, simulating a restart.
  const reloaded = await getGoalInternal("ses_1")
  expect(reloaded?.continuationFailures).toBe(2)
  expect(reloaded?.pendingAttempt).toBeNull()

  await recordContinuationResult("ses_1", "success", 5)
  const reloadedPending = await getGoalInternal("ses_1")
  expect(reloadedPending?.continuationFailures).toBe(2)
  expect(reloadedPending?.pendingAttempt?.reservedAt).toBeGreaterThanOrEqual(Date.now() - 5_000)
  expect(reloadedPending?.pendingAttempt?.started).toBe(false)

  await markPendingContinuationStarted("ses_1")
  const reloadedStarted = await getGoalInternal("ses_1")
  expect(reloadedStarted?.pendingAttempt?.started).toBe(true)
  expect(reloadedStarted?.pendingAttempt).not.toBeNull()
})

test("decodes persisted state that lacks the retry fields", async () => {
  await writeFile(
    process.env.OPENCODE_GOAL_STATE_PATH!,
    JSON.stringify({
      version: 1,
      goals: {
        ses_1: {
          sessionID: "ses_1",
          objective: "continue",
          status: "active",
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 1,
          updatedAt: 1,
          lastAccountedAt: 1,
          autoTurns: 0,
          lastContinuationAt: null,
        },
      },
    }),
  )

  const goal = await getGoalInternal("ses_1")

  expect(goal?.continuationFailures).toBe(0)
  expect(goal?.pendingAttempt).toBeNull()
})

test("substantive assistant text resets the failure count and pending window", async () => {
  await createGoal("ses_1", "keep going", null)
  await reserveContinuation("ses_1", 10, 0)
  await recordContinuationResult("ses_1", "failure", 5)
  await recordContinuationResult("ses_1", "failure", 5)
  await recordContinuationResult("ses_1", "success", 5)
  expect((await getGoalInternal("ses_1"))?.pendingAttempt).not.toBeNull()

  const progressed = await recordAssistantProgress("ses_1", {
    messageID: "m1",
    text: "Implemented the parser and added passing tests",
    outputTokens: 400,
    completedAt: Date.now(),
  })

  expect(progressed?.continuationFailures).toBe(0)
  expect((await getGoalInternal("ses_1"))?.pendingAttempt).toBeNull()
  expect(progressed?.status).toBe("active")
})

test("successful tool output clears transport failures but preserves no-progress evaluation", async () => {
  await createGoal("ses_1", "keep going", null)
  await reserveContinuation("ses_1", 10, 0)
  await recordContinuationResult("ses_1", "success", 5) // delivers: arms the no-progress window
  await recordContinuationResult("ses_1", "failure", 5) // not delivered -> resolves window + counts
  await recordContinuationResult("ses_1", "success", 5) // redelivers: arms the no-progress window again
  expect((await getGoal("ses_1"))?.continuationFailures).toBe(1)
  expect((await getGoal("ses_1"))?.awaitingContinuationProgress).toBe(true)
  expect((await getGoalInternal("ses_1"))?.pendingAttempt).not.toBeNull()

  const progressed = await recordToolProgress("ses_1", "tests passed")

  // Tool progress clears the transport failure counter and pending window...
  expect(progressed?.continuationFailures).toBe(0)
  expect(progressed?.pendingAttempt).toBeNull()
  // ...but MUST NOT reset the armed no-progress evaluation: the tool ran inside
  // a continuation turn, and the assistant's still-pending final text drives
  // the low-output accounting.
  expect(progressed?.awaitingContinuationProgress).toBe(true)
  expect(progressed?.noProgressTurns).toBe(0)
})

test("recordToolProgress only clears the pending attempt captured for the same tool call", async () => {
  await createGoal("ses_1", "keep going", null)
  await reserveContinuation("ses_1", 10, 0)
  await recordContinuationResult("ses_1", "success", 5)
  const attemptA = (await getGoalInternal("ses_1"))?.pendingAttempt?.id
  expect(attemptA).toMatch(/^att_/)

  // A newer attempt supersedes the one the (still-running) tool call started
  // under; the delayed output must not clear it.
  await reserveContinuation("ses_1", 10, 0)
  await recordContinuationResult("ses_1", "success", 5)
  const attemptB = (await getGoalInternal("ses_1"))?.pendingAttempt?.id
  expect(attemptB).not.toBe(attemptA)

  const delayed = await recordToolProgress("ses_1", "tests passed", attemptA)
  expect(delayed?.pendingAttempt?.id).toBe(attemptB)

  // Output from a call that started while attempt B was pending clears it.
  const cleared = await recordToolProgress("ses_1", "tests passed", attemptB)
  expect(cleared?.pendingAttempt).toBeNull()

  // A null capture (the tool call started with no pending attempt) cannot clear
  // an attempt that appeared while the call was still running.
  await reserveContinuation("ses_1", 10, 0)
  await recordContinuationResult("ses_1", "success", 5)
  const protectedNow = await recordToolProgress("ses_1", "tests passed", null)
  expect(protectedNow?.pendingAttempt).not.toBeNull()

  // Omitting the expected id keeps the legacy unconditional reset.
  const legacy = await recordToolProgress("ses_1", "tests passed")
  expect(legacy?.pendingAttempt).toBeNull()
})

test("re-reading the previous assistant message does not resolve a pending continuation", async () => {
  await createGoal("ses_1", "keep going", null)
  await recordAssistantProgress("ses_1", { messageID: "m1", text: "Initial progress" })
  await reserveContinuation("ses_1", 10, 0)
  await recordContinuationResult("ses_1", "success", 5)

  const repeated = await recordAssistantProgress("ses_1", {
    messageID: "m1",
    text: "Initial progress",
    evaluateContinuation: true,
    completedAt: Date.now(),
  })

  expect((await getGoalInternal("ses_1"))?.pendingAttempt).not.toBeNull()
  expect(repeated?.awaitingContinuationProgress).toBe(true)
})

test("lastContinuationAt remains a public seconds timestamp", async () => {
  await createGoal("ses_1", "keep going", null)
  const reserved = await reserveContinuation("ses_1", 10, 0)

  expect(reserved?.lastContinuationAt).toBe(Math.floor(Date.now() / 1000))
  expect(reserved?.lastContinuationAt).toBeLessThan(1_000_000_000_000)
})

test("resuming a paused goal clears the failure count and pending window", async () => {
  await createGoal("ses_1", "keep going", null)
  await recordContinuationResult("ses_1", "failure", 1)
  expect((await getGoal("ses_1"))?.status).toBe("paused")

  const resumed = await setGoalStatus("ses_1", "active")

  expect(resumed?.continuationFailures).toBe(0)
  expect((await getGoalInternal("ses_1"))?.pendingAttempt).toBeNull()
})

test("internal pending attempt fields are not exposed on the public snapshot", async () => {
  await createGoal("ses_1", "keep going", null)
  await reserveContinuation("ses_1", 10, 0)
  await recordContinuationResult("ses_1", "success", 5)

  const publicGoal = await getGoal("ses_1")
  expect(publicGoal).not.toHaveProperty("pendingAttempt")
  expect(publicGoal).not.toHaveProperty("pendingContinuationStart")
  expect(publicGoal).not.toHaveProperty("pendingContinuationStarted")
  expect(JSON.stringify(publicGoal)).not.toContain("pendingAttempt")

  // The dedicated internal API exposes the attempt lifecycle.
  const internalGoal = await getGoalInternal("ses_1")
  expect(internalGoal?.pendingAttempt).not.toBeNull()
  expect(internalGoal?.pendingAttempt?.id).toMatch(/^att_/)
})

test("rolling back a reserved-but-not-delivered attempt restores autoTurns and lastContinuationAt", async () => {
  await createGoal("ses_1", "keep going", null)
  await reserveContinuation("ses_1", 10, 0)
  expect((await getGoal("ses_1"))?.autoTurns).toBe(1)
  expect((await getGoalInternal("ses_1"))?.pendingAttempt?.delivered).toBe(false)

  const rolledBack = await rollbackContinuationAttempt("ses_1")
  expect(rolledBack).toBe(true)
  expect((await getGoal("ses_1"))?.autoTurns).toBe(0)
  expect((await getGoal("ses_1"))?.lastContinuationAt).toBeNull()
  expect((await getGoalInternal("ses_1"))?.pendingAttempt).toBeNull()

  // Rolling back again (nothing left) is a no-op.
  expect(await rollbackContinuationAttempt("ses_1")).toBe(false)
})

test("rolling back a delivered attempt is a no-op and does not un-consume the turn", async () => {
  await createGoal("ses_1", "keep going", null)
  await reserveContinuation("ses_1", 10, 0)
  await recordContinuationResult("ses_1", "success", 5)
  expect((await getGoalInternal("ses_1"))?.pendingAttempt?.delivered).toBe(true)

  expect(await rollbackContinuationAttempt("ses_1")).toBe(false)
  expect((await getGoal("ses_1"))?.autoTurns).toBe(1)
})

test("delayed prior-turn assistant output cannot clear a newer pending attempt", async () => {
  await createGoal("ses_1", "keep going", null)
  await recordAssistantProgress("ses_1", { messageID: "m_old", text: "Old work" })
  const reserved = await reserveContinuation("ses_1", 10, 0)
  const reservedAt = reserved?.pendingAttempt?.reservedAt ?? 0
  await recordContinuationResult("ses_1", "success", 5)

  // A delayed prior-turn message arrives late, completing BEFORE the attempt
  // was reserved. Its messageID is new, so the repeated-message guard alone
  // cannot reject it; the completedAt correlation must keep the pending
  // attempt intact.
  await recordAssistantProgress("ses_1", {
    messageID: "m_delayed",
    text: "Delayed old output that arrived late",
    completedAt: reservedAt - 10_000,
  })
  expect((await getGoalInternal("ses_1"))?.pendingAttempt).not.toBeNull()
  expect((await getGoal("ses_1"))?.continuationFailures).toBe(0)

  // A newer message completing after the attempt resolves it.
  await recordAssistantProgress("ses_1", {
    messageID: "m_new",
    text: "Current progress after the continuation",
    completedAt: reservedAt + 10_000,
  })
  expect((await getGoalInternal("ses_1"))?.pendingAttempt).toBeNull()
})
