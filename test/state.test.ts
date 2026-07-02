import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  accountUsage,
  clearGoal,
  completeGoal,
  createGoal,
  recordAssistantProgress,
  getGoal,
  markGoalUnmet,
  pauseGoalForPlanMode,
  recordPromptAgent,
  reserveContinuation,
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

test("records assistant checkpoints and pauses after repeated no-progress turns", async () => {
  await createGoal("ses_1", "continue", { noProgressTokenThreshold: 50, maxNoProgressTurns: 2 })
  const first = await recordAssistantProgress("ses_1", { messageID: "m1", text: "Inspected the repo", outputTokens: 10 })
  expect(first?.lastCheckpoint?.summary).toBe("Inspected the repo")
  expect(first?.status).toBe("active")

  await recordAssistantProgress("ses_1", { messageID: "m1", text: "Inspected the repo", outputTokens: 10 })
  const paused = await recordAssistantProgress("ses_1", { messageID: "m1", text: "Inspected the repo", outputTokens: 10 })

  expect(paused?.status).toBe("paused")
  expect(paused?.stopReason).toBe("no progress")
  expect(paused?.history.some((entry) => entry.type === "checkpoint")).toBe(true)
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
