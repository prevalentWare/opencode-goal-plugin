import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GoalPlanInputSchema, goalPlanEntries, type GoalPlanInput } from "../src/goal-plan"
import {
  cancelGoal,
  clearGoal,
  completeGoal,
  createGoal,
  getGoal,
  getGoalHistory,
  replaceGoal,
  updateGoalObjective,
  updateGoalPlan,
} from "../src/state"

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "goal-plan-test-"))
  process.env.OPENCODE_GOAL_STATE_PATH = join(dir, "goals.json")
})
afterEach(async () => {
  delete process.env.OPENCODE_GOAL_STATE_PATH
  await rm(dir, { recursive: true, force: true })
})

function initialPlan(): GoalPlanInput {
  return {
    summary: "Make the project production-ready",
    completionCriteria: ["Parser and execution tests pass"],
    decisions: ["Retain the original production-readiness scope"],
    phases: [
      {
        id: "parser",
        objective: "Parser correctness",
        status: "in_progress",
        tasks: [{ id: "compound", description: "Fix compound queries", status: "in_progress" }],
      },
      {
        id: "execution",
        objective: "Query execution",
        status: "pending",
        tasks: [{ id: "planner", description: "Implement the planner", status: "pending" }],
      },
    ],
  }
}

test("verified phases persist across reads and advance to remaining work without closing the overall goal", async () => {
  const goal = await createGoal("session", "Make the project production-ready")
  await updateGoalPlan("session", {
    goalID: goal.id,
    expectedRevision: 0,
    plan: initialPlan(),
    reason: "Plan the overall scope",
  })
  const next = initialPlan()
  next.phases[0]!.tasks[0]!.status = "completed"
  next.phases[0]!.tasks[0]!.evidence = "Compound-query regressions pass"
  next.phases[0]!.status = "completed"
  next.phases[0]!.verification = "Parser suite passes"
  const updated = await updateGoalPlan("session", {
    goalID: goal.id,
    expectedRevision: 1,
    plan: next,
    reason: "Parser verified; reassess query execution",
  })
  expect(updated).toMatchObject({
    objective: goal.objective,
    status: "active",
    planRevision: 2,
    planProgress: {
      currentPhaseID: "execution",
      currentTaskID: null,
      nextTaskID: "planner",
      completedTaskIDs: ["compound"],
    },
  })
  const persisted = JSON.parse(await readFile(process.env.OPENCODE_GOAL_STATE_PATH!, "utf8"))
  expect(persisted.version).toBe(3)
  expect((await getGoal("session"))?.plan).toEqual(persisted.goals.session.plan)
  expect(goalPlanEntries(updated.plan!)).toEqual([
    { content: "Parser correctness: Fix compound queries", status: "completed", priority: "medium" },
    { content: "Query execution: Implement the planner", status: "pending", priority: "medium" },
  ])
  await expect(completeGoal("session", "A parser task passed")).rejects.toThrow("planned phases")
  await cancelGoal("session")
  await clearGoal("session")
  expect((await getGoalHistory("session")).previous[0]?.plan?.revision).toBe(2)
})

test("stale, narrowed, deleted or reopened completed work cannot overwrite a verified plan", async () => {
  const goal = await createGoal("session", "Make the project production-ready")
  const plan = initialPlan()
  plan.phases[0]!.tasks[0]!.status = "completed"
  plan.phases[0]!.tasks[0]!.evidence = "Regression passes"
  plan.phases[0]!.status = "completed"
  plan.phases[0]!.verification = "Parser suite passes"
  const update = (plan: GoalPlanInput, revision = 1, revisitEvidence?: string) =>
    updateGoalPlan("session", {
      goalID: goal.id,
      expectedRevision: revision,
      plan,
      reason: "Reassess remaining scope",
      revisitEvidence,
    })
  await update(plan, 0)
  await expect(update(initialPlan(), 0)).rejects.toThrow("revision changed")
  await expect(update(initialPlan())).rejects.toThrow("reopening")
  await expect(update({ ...plan, completionCriteria: ["Only parser tests pass"] })).rejects.toThrow(
    "completion criteria",
  )
  await expect(update({ ...plan, phases: [plan.phases[1]!] })).rejects.toThrow("verified phase")
  expect(
    (await update(initialPlan(), 1, "A newly failing compound-query regression requires revisiting the parser"))
      .planRevision,
  ).toBe(2)
})

test("task and phase completion require evidence and a phase cannot leap over unfinished work", () => {
  const plan = initialPlan()
  plan.phases[0]!.tasks[0]!.status = "completed"
  expect(GoalPlanInputSchema.safeParse(plan).success).toBe(false)
  plan.phases[0]!.tasks[0]!.evidence = "Regression passes"
  plan.phases[0]!.status = "completed"
  expect(GoalPlanInputSchema.safeParse(plan).success).toBe(false)
  plan.phases[0]!.verification = "Parser verified"
  expect(GoalPlanInputSchema.safeParse(plan).success).toBe(true)
  const jumped = initialPlan()
  jumped.phases[0]!.status = "pending"
  jumped.phases[0]!.tasks[0]!.status = "pending"
  jumped.phases[1]!.status = "in_progress"
  expect(GoalPlanInputSchema.safeParse(jumped).success).toBe(false)
})

test("scope edits and replacements reject an old planner's delayed update", async () => {
  const goal = await createGoal("session", "Original scope")
  const input = { goalID: goal.id, expectedRevision: 0, plan: initialPlan(), reason: "Original plan" }
  await updateGoalObjective("session", "Explicitly edited scope")
  await expect(updateGoalPlan("session", input)).rejects.toThrow("revision changed")
  await replaceGoal("session", "New independent scope")
  await expect(updateGoalPlan("session", input)).rejects.toThrow("replaced")
})

test("version 2 state upgrades without changing existing goal identity or accounting", async () => {
  const goal = await createGoal("session", "Legacy goal", 100)
  const file = process.env.OPENCODE_GOAL_STATE_PATH!
  const state = JSON.parse(await readFile(file, "utf8"))
  state.version = 2
  delete state.goals.session.plan
  delete state.goals.session.planRevision
  await writeFile(file, JSON.stringify(state))
  expect(await getGoal("session")).toMatchObject({ id: goal.id, tokenBudget: 100, plan: null, planRevision: 0 })
  await updateGoalPlan("session", {
    goalID: goal.id,
    expectedRevision: 0,
    plan: initialPlan(),
    reason: "Add a durable plan",
  })
  expect(JSON.parse(await readFile(file, "utf8")).version).toBe(3)
})

test("pending phase and task scope cannot disappear without recorded revisit evidence", async () => {
  const goal = await createGoal("session", "Keep the full engine scope")
  await updateGoalPlan("session", { goalID: goal.id, expectedRevision: 0, plan: initialPlan(), reason: "Full scope" })
  const narrowed = initialPlan()
  narrowed.phases.pop()
  await expect(
    updateGoalPlan("session", { goalID: goal.id, expectedRevision: 1, plan: narrowed, reason: "Only parser remains" }),
  ).rejects.toThrow("scope")
  const changed = initialPlan()
  changed.phases[1]!.objective = "Only parsing"
  await expect(
    updateGoalPlan("session", { goalID: goal.id, expectedRevision: 1, plan: changed, reason: "Narrow execution" }),
  ).rejects.toThrow("scope")
  const revised = await updateGoalPlan("session", {
    goalID: goal.id,
    expectedRevision: 1,
    plan: narrowed,
    reason: "Reassess the execution phase",
    revisitEvidence:
      "The execution engine already exists; acceptance runs prove the overall execution criterion is satisfied",
  })
  expect(revised.plan?.changes.at(-1)?.revisitEvidence).toContain("acceptance runs")
})

test("one plan revision reports shape and scope violations together with field paths", async () => {
  const goal = await createGoal("session", "Keep the full engine scope")
  await updateGoalPlan("session", { goalID: goal.id, expectedRevision: 0, plan: initialPlan(), reason: "Full scope" })
  const invalid = initialPlan()
  invalid.phases[0]!.objective = "Parser only"
  invalid.phases[0]!.tasks[0]!.description = "Rewrite the parser"
  invalid.phases[1]!.status = "blocked"
  const rejected = updateGoalPlan("session", {
    goalID: goal.id, expectedRevision: 1, plan: invalid, reason: "Block execution",
  })
  await expect(rejected).rejects.toThrow("phases[execution].blocker: blocked phases require a blocker")
  await expect(rejected).rejects.toThrow("phases[parser].objective")
  await expect(rejected).rejects.toThrow("tasks[compound].description")
  expect((await getGoal("session"))?.planRevision).toBe(1)
})

test("bounded plan operations update a large plan atomically without resending it", async () => {
  const goal = await createGoal("session", "Keep the full engine scope")
  const plan = initialPlan()
  plan.phases.push(...Array.from({ length: 10 }, (_, index) => ({
    id: `later-${index}`,
    objective: `Later work ${index}`,
    status: "pending" as const,
    tasks: Array.from({ length: 4 }, (_, taskIndex) => ({
      id: `later-${index}-${taskIndex}`,
      description: `Task ${taskIndex} in phase ${index}`,
      status: "pending" as const,
    })),
  })))
  await updateGoalPlan("session", { goalID: goal.id, expectedRevision: 0, plan, reason: "Full scope" })
  const ops = [
    { op: "set_task" as const, task_id: "compound", status: "completed" as const, evidence: "Tests pass" },
    { op: "set_phase" as const, phase_id: "parser", status: "completed" as const, verification: "Parser verified" },
    { op: "set_phase" as const, phase_id: "execution", status: "in_progress" as const },
    { op: "set_task" as const, task_id: "planner", status: "in_progress" as const },
  ]
  const updated = await updateGoalPlan("session", {
    goalID: goal.id, expectedRevision: 1, planOps: ops, reason: "Parser complete; start planner",
  })
  expect(updated.planProgress).toMatchObject({ currentPhaseID: "execution", currentTaskID: "planner" })
  expect(updated.plan?.phases).toHaveLength(12)
  expect(updated.planRevision).toBe(2)
  await expect(updateGoalPlan("session", {
    goalID: goal.id, expectedRevision: 1, planOps: ops, reason: "Stale replay",
  })).rejects.toThrow("revision changed")
  await expect(updateGoalPlan("session", {
    goalID: goal.id, expectedRevision: 2,
    planOps: [{ op: "set_task", task_id: "unknown", status: "completed", evidence: "No task" }],
    reason: "Unknown task",
  })).rejects.toThrow("plan_ops[0].task_id (unknown): unknown task ID")
  expect((await getGoal("session"))?.planRevision).toBe(2)
})

test("reopening work clears old proof and unblocking clears obsolete blocker text", async () => {
  const goal = await createGoal("session", "Verify parser work")
  const plan = initialPlan()
  plan.phases[0]!.tasks[0]!.status = "completed"
  plan.phases[0]!.tasks[0]!.evidence = "Original tests pass"
  plan.phases[0]!.status = "completed"
  plan.phases[0]!.verification = "Original parser suite passes"
  await updateGoalPlan("session", { goalID: goal.id, expectedRevision: 0, plan, reason: "Original proof" })
  const reopened = await updateGoalPlan("session", {
    goalID: goal.id, expectedRevision: 1, reason: "Regression found",
    revisitEvidence: "A new regression invalidates the previous proof",
    planOps: [
      { op: "set_phase", phase_id: "parser", status: "in_progress" },
      { op: "set_task", task_id: "compound", status: "in_progress" },
    ],
  })
  expect(reopened.plan?.phases[0]?.verification).toBeNull()
  expect(reopened.plan?.phases[0]?.tasks[0]?.evidence).toBeNull()
  await expect(updateGoalPlan("session", {
    goalID: goal.id, expectedRevision: 2, reason: "Claim completion without fresh proof",
    planOps: [{ op: "set_task", task_id: "compound", status: "completed" }],
  })).rejects.toThrow("phases[parser].tasks[compound].evidence")
  expect((await getGoal("session"))?.planRevision).toBe(2)

  const blocked = await updateGoalPlan("session", {
    goalID: goal.id, expectedRevision: 2, reason: "Waiting on API",
    planOps: [{ op: "set_task", task_id: "compound", status: "blocked", blocker: "API down" }],
  })
  expect(goalPlanEntries(blocked.plan!)[0]?.content).toContain("Blocked: API down")
  const resolved = await updateGoalPlan("session", {
    goalID: goal.id, expectedRevision: 3, reason: "API recovered",
    planOps: [{ op: "set_task", task_id: "compound", status: "completed", evidence: "Fresh tests pass" }],
  })
  expect(resolved.plan?.phases[0]?.tasks[0]?.blocker).toBeNull()
  expect(goalPlanEntries(resolved.plan!)[0]?.content).not.toContain("Blocked: API down")
})

test("full-plan reopening discards stale proof and nonblocked blocker text", async () => {
  const goal = await createGoal("session", "Verify parser work")
  const completed = initialPlan()
  completed.phases[0]!.status = "completed"
  completed.phases[0]!.verification = "Old phase proof"
  completed.phases[0]!.tasks[0]!.status = "completed"
  completed.phases[0]!.tasks[0]!.evidence = "Old task proof"
  await updateGoalPlan("session", {
    goalID: goal.id, expectedRevision: 0, plan: completed, reason: "Original completion",
  })
  const reopened = structuredClone(completed)
  reopened.phases[0]!.status = "in_progress"
  reopened.phases[0]!.blocker = "Old outage"
  reopened.phases[0]!.tasks[0]!.status = "in_progress"
  reopened.phases[0]!.tasks[0]!.blocker = "Old outage"
  const update = await updateGoalPlan("session", {
    goalID: goal.id, expectedRevision: 1, plan: reopened, reason: "Regression found",
    revisitEvidence: "New regression invalidated the original proof",
  })
  expect(update.plan?.phases[0]?.verification).toBeNull()
  expect(update.plan?.phases[0]?.tasks[0]?.evidence).toBeNull()
  expect(update.plan?.phases[0]?.blocker).toBeNull()
  expect(update.plan?.phases[0]?.tasks[0]?.blocker).toBeNull()
  const missingProof = structuredClone({
    summary: update.plan!.summary,
    completionCriteria: update.plan!.completionCriteria,
    phases: update.plan!.phases,
    decisions: update.plan!.decisions,
  })
  missingProof.phases[0]!.tasks[0]!.status = "completed"
  await expect(updateGoalPlan("session", {
    goalID: goal.id, expectedRevision: 2, plan: missingProof, reason: "Claim old proof",
  })).rejects.toThrow("phases[parser].tasks[compound].evidence")
})

test("plan operation errors and resulting plan violations are reported together by ID", async () => {
  const goal = await createGoal("session", "Keep the full engine scope")
  await updateGoalPlan("session", { goalID: goal.id, expectedRevision: 0, plan: initialPlan(), reason: "Full scope" })
  const rejected = updateGoalPlan("session", {
    goalID: goal.id, expectedRevision: 1, reason: "Try several edits",
    planOps: [
      { op: "set_task", task_id: "typo-a", status: "completed", evidence: "No task" },
      { op: "set_phase", phase_id: "execution", status: "blocked" },
      { op: "set_task", task_id: "typo-b", status: "blocked", blocker: "No task" },
    ],
  })
  await expect(rejected).rejects.toThrow("plan_ops[0].task_id (typo-a): unknown task ID")
  await expect(rejected).rejects.toThrow("phases[execution].blocker: blocked phases require a blocker")
  await expect(rejected).rejects.toThrow("plan_ops[2].task_id (typo-b): unknown task ID")
  expect((await getGoal("session"))?.planRevision).toBe(1)
})

test("a planned objective can only clear its plan with an explicit grant for that goal and exact objective", async () => {
  const goal = await createGoal("session", "Keep the full engine scope")
  await updateGoalPlan("session", { goalID: goal.id, expectedRevision: 0, plan: initialPlan(), reason: "Full scope" })
  await expect(updateGoalObjective("session", "Only parser")).rejects.toThrow("/goal edit")
  await expect(
    updateGoalObjective("session", "Only parser", "active", {
      requestedPlanEdit: { goalID: "another-goal", objective: "Only parser" },
    }),
  ).rejects.toThrow("/goal edit")
  await expect(
    updateGoalObjective("session", "Only parser", "active", {
      requestedPlanEdit: { goalID: goal.id, objective: "Wrong objective" },
    }),
  ).rejects.toThrow("/goal edit")
  const edited = await updateGoalObjective("session", "Only parser", "active", {
    requestedPlanEdit: { goalID: goal.id, objective: "Only parser" },
  })
  expect(edited).toMatchObject({ objective: "Only parser", plan: null, planRevision: 2 })
})
