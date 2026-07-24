import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  accountMessageUsage,
  accountUsage,
  cancelContinuationReservation,
  clearGoal,
  completeGoal,
  createGoal,
  recordAssistantProgress,
  getGoal,
  markGoalBlocked,
  pauseGoalForPlanMode,
  recordContinuationResult,
  recordPromptAgent,
  recordPromptRuntime,
  reserveContinuation,
  setGoalStatus,
  updateGoalObjective,
} from "../src/state"
import type { ContinuationReservation } from "../src/state"

let dir = ""

async function reserveForTest(sessionID = "ses_1", maxAutoTurns = 10): Promise<ContinuationReservation> {
  const reserved = await reserveContinuation(sessionID, maxAutoTurns, 0)
  if (!reserved?.continuationReservation) throw new Error("expected a continuation reservation")
  return reserved.continuationReservation
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, message: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(message)
    await Bun.sleep(10)
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "slash-goal-for-opencode-"))
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

test("marks a goal blocked only after three goal turns and requires resume before more work", async () => {
  await createGoal("ses_1", "ship the plugin", 100)
  await expect(markGoalBlocked("ses_1", "missing external credentials")).rejects.toThrow("(1/3)")
  await recordPromptRuntime("ses_1", { countGoalTurn: true })
  await recordPromptRuntime("ses_1", { countGoalTurn: true })
  const blocked = await markGoalBlocked("ses_1", "missing external credentials")

  expect(blocked.status).toBe("blocked")
  expect(blocked.blocker).toBe("missing external credentials")
  await expect(createGoal("ses_1", "ship follow-up", null)).rejects.toThrow("non-closed goal")

  await setGoalStatus("ses_1", "active")
  await completeGoal("ses_1")
  const next = await createGoal("ses_1", "ship follow-up", null)
  expect(next.status).toBe("active")
  expect(next.objective).toBe("ship follow-up")
})

test("enforces the native 4000-character objective bound", async () => {
  const accepted = await createGoal("ses_1", "x".repeat(4000), null)
  expect([...accepted.objective]).toHaveLength(4000)
  await completeGoal("ses_1")
  await expect(createGoal("ses_1", "x".repeat(4001), null)).rejects.toThrow("at most 4000 characters")
})

test("native update semantics do not require model-supplied evidence or blocker fields", async () => {
  await createGoal("ses_1", "ship the plugin", 100)
  const completed = await completeGoal("ses_1")
  expect(completed.status).toBe("complete")
  expect(completed.completionEvidence).toBeNull()
})

test("token usage marks goals budget limited", async () => {
  await createGoal("ses_1", "stay active", 10)
  const updated = await accountUsage("ses_1", 12)
  expect(updated?.status).toBe("budgetLimited")
  expect(updated?.remainingTokens).toBe(0)
  expect(updated?.tokensUsed).toBe(12)
  expect(updated?.stopReason).toContain("token budget reached")
})

test("exact message usage replaces estimates downward or upward and keeps explicit zero exact", async () => {
  await createGoal("ses_1", "account accurately", 50)

  expect((await accountMessageUsage("ses_1", "m_down", 100, "estimated"))?.status).toBe("budgetLimited")
  const correctedDown = await accountMessageUsage("ses_1", "m_down", 40, "exact")
  expect(correctedDown?.tokensUsed).toBe(40)
  expect(correctedDown?.status).toBe("active")

  await accountMessageUsage("ses_1", "m_up", 2, "estimated")
  const correctedUp = await accountMessageUsage("ses_1", "m_up", 12, "exact")
  expect(correctedUp?.tokensUsed).toBe(52)
  expect(correctedUp?.status).toBe("budgetLimited")

  await accountMessageUsage("ses_1", "m_zero", 0, "exact")
  const ignoredEstimate = await accountMessageUsage("ses_1", "m_zero", 500, "estimated")
  expect(ignoredEstimate?.tokensUsed).toBe(52)

  await accountMessageUsage("ses_1", "m_monotonic", 20, "exact")
  await accountMessageUsage("ses_1", "m_monotonic", 5, "exact")
  expect((await getGoal("ses_1"))?.tokensUsed).toBe(72)

  const persisted = JSON.parse(await readFile(process.env.OPENCODE_GOAL_STATE_PATH!, "utf8"))
  expect(persisted.goals.ses_1.accountedMessageExact).toMatchObject({ m_down: true, m_up: true, m_zero: true })
})

test("retains more than 64 accounted message identities across persisted reloads", async () => {
  await createGoal("ses_1", "long goal", null)
  for (let index = 0; index < 70; index += 1) {
    await accountMessageUsage("ses_1", `m_${index}`, 1, "exact")
  }

  expect((await getGoal("ses_1"))?.tokensUsed).toBe(70)
  await accountMessageUsage("ses_1", "m_0", 1, "exact")
  expect((await getGoal("ses_1"))?.tokensUsed).toBe(70)

  const persisted = JSON.parse(await readFile(process.env.OPENCODE_GOAL_STATE_PATH!, "utf8"))
  expect(persisted.goals.ses_1.accountedMessageOrder).toHaveLength(70)
  expect(Object.keys(persisted.goals.ses_1.accountedMessageTokens)).toHaveLength(70)
})

test("reserves continuation until max auto turns is reached", async () => {
  await createGoal("ses_1", "continue", null)
  await recordContinuationResult("ses_1", await reserveForTest("ses_1", 1), "success", 3)
  const limited = await reserveContinuation("ses_1", 1, 0)
  expect(limited?.status).toBe("usageLimited")
  expect(limited?.budgetWrapupSent).toBe(true)
  expect(await reserveContinuation("ses_1", 1, 0)).toBeNull()
  expect((await getGoal("ses_1"))?.status).toBe("usageLimited")
})

test("stale continuation results and cancellations cannot alter a newer reservation", async () => {
  await createGoal("ses_1", "continue", null)
  const first = await reserveForTest()
  await recordPromptRuntime("ses_1", { countGoalTurn: true })
  const second = await reserveForTest()

  await cancelContinuationReservation("ses_1", first)
  await recordContinuationResult("ses_1", first, "success", 3)
  const stillReserved = await getGoal("ses_1")

  expect(stillReserved?.continuationReservation).toEqual(second)
  expect(stillReserved?.awaitingContinuationProgress).toBe(false)
  await cancelContinuationReservation("ses_1", second)
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

  await recordContinuationResult("ses_1", await reserveForTest(), "success", 3)
  const firstStall = await recordAssistantProgress("ses_1", {
    messageID: "m1",
    text: "Working on it",
    outputTokens: 10,
    evaluateContinuation: true,
  })
  expect(firstStall?.noProgressTurns).toBe(1)
  expect(firstStall?.status).toBe("active")

  await recordContinuationResult("ses_1", await reserveForTest(), "success", 3)
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

  await recordContinuationResult("ses_1", await reserveForTest(), "success", 3)
  await recordAssistantProgress("ses_1", { messageID: "m1", text: "Working on it", outputTokens: 10, evaluateContinuation: true })

  await recordContinuationResult("ses_1", await reserveForTest(), "success", 3)
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
  await recordContinuationResult("ses_1", await reserveForTest(), "success", 3)

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
  if (!reserved?.continuationReservation) throw new Error("expected a continuation reservation")

  const failed = await recordContinuationResult("ses_1", reserved.continuationReservation, "failure", 3)
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

test("objective edits reset the blocked audit and stale continuation evaluation", async () => {
  await createGoal("ses_1", "old objective", { noProgressTokenThreshold: 50, maxNoProgressTurns: 2 })
  await recordPromptRuntime("ses_1", { countGoalTurn: true })
  await recordPromptRuntime("ses_1", { countGoalTurn: true })
  await recordAssistantProgress("ses_1", { messageID: "m0", text: "Old checkpoint", outputTokens: 100 })
  await recordContinuationResult("ses_1", await reserveForTest(), "success", 3)

  const updated = await updateGoalObjective("ses_1", "new objective")

  expect(updated.blockedAuditTurns).toBe(1)
  expect(updated.awaitingContinuationProgress).toBe(false)
  expect(updated.continuationBaselineMessageID).toBe("")
  expect(updated.continuationBaselineSummary).toBe("")
  expect(updated.lastContinuationAt).toBeNull()
  await expect(markGoalBlocked("ses_1", "old blocker")).rejects.toThrow("(1/3)")
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

test("migrates legacy upstream unmet state to native blocked", async () => {
  await writeFile(
    process.env.OPENCODE_GOAL_STATE_PATH!,
    JSON.stringify({
      version: 1,
      goals: {
        ses_1: {
          sessionID: "ses_1",
          objective: "continue after migration",
          status: "unmet",
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 1,
          updatedAt: 1,
          lastAccountedAt: null,
          autoTurns: 0,
          lastContinuationAt: null,
          history: [{ type: "unmet", detail: "legacy blocker", timestamp: 1 }],
        },
      },
    }),
  )

  const goal = await getGoal("ses_1")
  expect(goal?.status).toBe("blocked")
  expect(goal?.history[0]?.type).toBe("blocked")
})

test("writes state with owner-only file permissions", async () => {
  await createGoal("ses_1", "ship the plugin", null)

  const mode = (await stat(process.env.OPENCODE_GOAL_STATE_PATH!)).mode & 0o777

  if (process.platform === "win32") {
    expect(mode).toBeGreaterThan(0)
  } else {
    expect(mode).toBe(0o600)
  }
})

test("ignores legacy stale lockfiles without deleting an unknown owner", async () => {
  const lockPath = `${process.env.OPENCODE_GOAL_STATE_PATH!}.lock`
  await writeFile(lockPath, "stale-owner\n0\n", "utf8")
  await utimes(lockPath, new Date(0), new Date(0))

  const created = await createGoal("ses_1", "ship the plugin", null)

  expect(created.status).toBe("active")
  expect(await readFile(lockPath, "utf8")).toBe("stale-owner\n0\n")
})

test(
  "serializes multiple cross-process contenders without stale-owner release overlap",
  async () => {
    const fixture = join(import.meta.dir, "fixtures", "state-lock-contender.ts")
    const eventLog = join(dir, "lock-events.log")
    const names = ["a", "b", "c"] as const
    const entered = Object.fromEntries(names.map((name) => [name, join(dir, `entered-${name}`)])) as Record<
      (typeof names)[number],
      string
    >
    const release = Object.fromEntries(names.map((name) => [name, join(dir, `release-${name}`)])) as Record<
      (typeof names)[number],
      string
    >
    const events = async () =>
      readFile(eventLog, "utf8").then(
        (value) => value.trim().split(/\r?\n/).filter(Boolean),
        () => [] as string[],
      )
    const start = (name: (typeof names)[number]) =>
      Bun.spawn({
        cmd: [process.execPath, fixture, name, entered[name], release[name], eventLog],
        env: { ...process.env, OPENCODE_GOAL_STATE_PATH: process.env.OPENCODE_GOAL_STATE_PATH! },
        stdout: "ignore",
        stderr: "pipe",
      })

    await writeFile(`${process.env.OPENCODE_GOAL_STATE_PATH!}.lock`, "legacy-stale-owner\n", "utf8")
    const processes = [start("a")]
    try {
      await waitUntil(() => stat(entered.a).then(() => true, () => false), "first contender never acquired the lock")
      processes.push(start("b"), start("c"))
      await Bun.sleep(100)
      expect(await events()).toEqual(["enter:a"])

      await writeFile(release.a, "release", "utf8")
      await waitUntil(async () => (await events()).filter((entry) => entry.startsWith("enter:")).length === 2, "second contender never acquired the lock")
      const second = (await events()).find((entry) => entry.startsWith("enter:") && entry !== "enter:a")?.slice(-1) as "b" | "c"
      expect(["b", "c"]).toContain(second)

      await writeFile(release[second], "release", "utf8")
      await waitUntil(async () => (await events()).filter((entry) => entry.startsWith("enter:")).length === 3, "third contender never acquired the lock")
      const third = second === "b" ? "c" : "b"
      await writeFile(release[third], "release", "utf8")

      expect(await Promise.all(processes.map((process) => process.exited))).toEqual([0, 0, 0])
      const finalEvents = await events()
      expect(finalEvents).toEqual(["enter:a", "exit:a", `enter:${second}`, `exit:${second}`, `enter:${third}`, `exit:${third}`])
    } finally {
      await Promise.all(names.map((name) => writeFile(release[name], "release", "utf8").catch(() => undefined)))
      await Promise.all(processes.map((process) => process.exited))
    }
  },
  15_000,
)

test("zero auto-turn limit remains unbounded like native Codex", async () => {
  await createGoal("ses_1", "continue", null)
  await recordContinuationResult("ses_1", await reserveForTest("ses_1", 0), "success", 3)
  await recordContinuationResult("ses_1", await reserveForTest("ses_1", 0), "success", 3)
  expect((await reserveContinuation("ses_1", 0, 0))?.autoTurns).toBe(3)
})

test("does not overwrite corrupt persisted state", async () => {
  await writeFile(process.env.OPENCODE_GOAL_STATE_PATH!, "{not valid json", "utf8")

  await expect(createGoal("ses_1", "ship the plugin", null)).rejects.toThrow()

  expect(await readFile(process.env.OPENCODE_GOAL_STATE_PATH!, "utf8")).toBe("{not valid json")
})
