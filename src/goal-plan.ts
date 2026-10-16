import { z } from "zod"

const text = z.string().trim().min(1).max(2000)
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/)
const status = z.enum(["pending", "in_progress", "completed", "blocked"])
const task = z
  .object({
    id,
    description: text,
    status,
    evidence: text.nullish(),
    blocker: text.nullish(),
  })
  .strict()
const phase = z
  .object({
    id,
    objective: text,
    status,
    tasks: z.array(task).min(1).max(128),
    verification: text.nullish(),
    blocker: text.nullish(),
  })
  .strict()

export const GoalPlanOpSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("set_phase"),
    phase_id: id,
    status: status.optional(),
    verification: text.nullable().optional(),
    blocker: text.nullable().optional(),
  }).strict(),
  z.object({
    op: z.literal("set_task"),
    task_id: id,
    status: status.optional(),
    evidence: text.nullable().optional(),
    blocker: text.nullable().optional(),
  }).strict(),
  z.object({ op: z.literal("append_decision"), decision: text }).strict(),
])
export type GoalPlanOp = z.infer<typeof GoalPlanOpSchema>
export const GoalPlanOpsSchema = z.array(GoalPlanOpSchema).min(1).max(32)

export const GoalPlanDraftSchema = z
  .object({
    summary: text,
    completionCriteria: z.array(text).min(1).max(32),
    phases: z.array(phase).min(1).max(64),
    decisions: z.array(text).max(32).default([]),
  })
  .strict()

export const GoalPlanInputSchema = GoalPlanDraftSchema.superRefine((plan, ctx) => {
    const ids = new Set<string>()
    let runningPhases = 0
    let runningTasks = 0
    for (const [phaseIndex, phase] of plan.phases.entries()) {
      const phasePath = ["phases", phaseIndex] as const
      if (ids.has(phase.id)) ctx.addIssue({ code: "custom", message: "plan IDs must be unique", path: [...phasePath, "id"] })
      ids.add(phase.id)
      if (phase.status === "in_progress") runningPhases++
      if (phase.status === "blocked" && !phase.blocker)
        ctx.addIssue({ code: "custom", message: "blocked phases require a blocker", path: [...phasePath, "blocker"] })
      if (
        phase.status === "completed" &&
        (!phase.verification || phase.tasks.some((task) => task.status !== "completed"))
      ) {
        ctx.addIssue({
          code: "custom",
          message: "completed phases require verified tasks and phase verification",
          path: [...phasePath, "verification"],
        })
      }
      for (const [taskIndex, task] of phase.tasks.entries()) {
        const taskPath = [...phasePath, "tasks", taskIndex] as const
        if (ids.has(task.id)) ctx.addIssue({ code: "custom", message: "plan IDs must be unique", path: [...taskPath, "id"] })
        ids.add(task.id)
        if (task.status === "completed" && !task.evidence)
          ctx.addIssue({ code: "custom", message: "completed tasks require evidence", path: [...taskPath, "evidence"] })
        if (task.status === "blocked" && !task.blocker)
          ctx.addIssue({ code: "custom", message: "blocked tasks require a blocker", path: [...taskPath, "blocker"] })
        if (task.status === "in_progress") {
          runningTasks++
          if (phase.status !== "in_progress")
            ctx.addIssue({ code: "custom", message: "running tasks require a running phase", path: [...taskPath, "status"] })
        }
      }
    }
    const firstUnfinished = plan.phases.find((phase) => phase.status !== "completed")
    if (plan.phases.some((phase) => phase.status === "in_progress" && phase !== firstUnfinished))
      ctx.addIssue({ code: "custom", message: "verify the current phase before starting the next phase", path: ["phases"] })
    if (runningPhases > 1 || runningTasks > 1)
      ctx.addIssue({ code: "custom", message: "choose one current phase and task", path: ["phases"] })
    if (ids.size > 576 || JSON.stringify(plan).length > 128_000)
      ctx.addIssue({ code: "custom", message: "plan exceeds the persistent state size limit", path: ["phases"] })
  })

export type GoalPlanInput = z.infer<typeof GoalPlanInputSchema>
export const GoalPlanSchema = GoalPlanInputSchema.safeExtend({
  decisions: z.array(text).max(32),
  revision: z.number().int().positive(),
  updatedAt: z.number().finite().nonnegative(),
  changes: z
    .array(
      z
        .object({
          revision: z.number().int().positive(),
          reason: text,
          timestamp: z.number().finite(),
          revisitEvidence: text.optional(),
        })
        .strict(),
    )
    .max(32),
})
export type GoalPlan = z.infer<typeof GoalPlanSchema>

export function applyGoalPlanOps(previous: GoalPlan | null, ops: GoalPlanOp[]) {
  if (!previous) throw new Error("plan_ops requires an existing plan; create one with plan")
  const next: GoalPlanInput = structuredClone({
    summary: previous.summary,
    completionCriteria: previous.completionCriteria,
    phases: previous.phases,
    decisions: previous.decisions,
  })
  const errors: string[] = []
  for (const [index, op] of GoalPlanOpsSchema.parse(ops).entries()) {
    if (op.op === "append_decision") {
      next.decisions.push(op.decision)
      continue
    }
    if (op.op === "set_phase") {
      if (op.status === undefined && op.verification === undefined && op.blocker === undefined) {
        errors.push(`plan_ops[${index}].phase_id (${op.phase_id}): set_phase requires a field to change`)
        continue
      }
      const target = next.phases.find((phase) => phase.id === op.phase_id)
      if (!target) {
        errors.push(`plan_ops[${index}].phase_id (${op.phase_id}): unknown phase ID`)
        continue
      }
      if (op.status !== undefined && op.status !== target.status) {
        if (op.status !== "completed") target.verification = null
        if (op.status !== "blocked") target.blocker = null
      }
      if (op.status !== undefined) target.status = op.status
      if (op.verification !== undefined) target.verification = op.verification
      if (op.blocker !== undefined) target.blocker = op.blocker
      continue
    }
    if (op.status === undefined && op.evidence === undefined && op.blocker === undefined) {
      errors.push(`plan_ops[${index}].task_id (${op.task_id}): set_task requires a field to change`)
      continue
    }
    const target = next.phases.flatMap((phase) => phase.tasks).find((task) => task.id === op.task_id)
    if (!target) {
      errors.push(`plan_ops[${index}].task_id (${op.task_id}): unknown task ID`)
      continue
    }
    if (op.status !== undefined && op.status !== target.status) {
      if (op.status !== "completed") target.evidence = null
      if (op.status !== "blocked") target.blocker = null
    }
    if (op.status !== undefined) target.status = op.status
    if (op.evidence !== undefined) target.evidence = op.evidence
    if (op.blocker !== undefined) target.blocker = op.blocker
  }
  return { plan: next, errors }
}

function planError(path: string, message: string, before?: string, after?: string) {
  const summarize = (value: string | undefined) =>
    JSON.stringify(value && value.length > 120 ? `${value.slice(0, 117)}...` : value)
  const change = before === undefined ? "" : ` (${summarize(before)} -> ${summarize(after)})`
  return `${path}${change}: ${message}`
}

function planPath(path: PropertyKey[], input: GoalPlanInput) {
  if (path[0] !== "phases" || typeof path[1] !== "number") return path.join(".") || "plan"
  const phase = input.phases[path[1]]
  if (!phase) return path.join(".")
  const prefix = `phases[${phase.id}]`
  if (path[2] !== "tasks" || typeof path[3] !== "number")
    return `${prefix}${path.length > 2 ? `.${path.slice(2).join(".")}` : ""}`
  const task = phase.tasks[path[3]]
  return task
    ? `${prefix}.tasks[${task.id}]${path.length > 4 ? `.${path.slice(4).join(".")}` : ""}`
    : path.join(".")
}

function planValidationErrors(input: GoalPlanInput) {
  const parsed = GoalPlanInputSchema.safeParse(input)
  return parsed.success ? [] : parsed.error.issues.map((issue) => `${planPath(issue.path, input)}: ${issue.message}`)
}

/** A task result advances the plan, never the overall goal's scope or lifecycle. */
export function reviseGoalPlan(
  previous: GoalPlan | null,
  input: GoalPlanInput,
  expectedRevision: number,
  reason: string,
  now: number,
  revisitEvidence?: string,
  currentRevision = previous?.revision ?? 0,
  preflightErrors: string[] = [],
): GoalPlan {
  if (expectedRevision !== currentRevision)
    throw new Error("goal plan revision changed; read get_goal before updating it")
  const next = GoalPlanDraftSchema.parse(input)
  const why = text.parse(reason)
  if (previous) {
    for (const newPhase of next.phases) {
      const oldPhase = previous.phases.find((phase) => phase.id === newPhase.id)
      if (oldPhase?.status === "completed" && newPhase.status !== "completed")
        newPhase.verification = null
      if (newPhase.status !== "blocked") newPhase.blocker = null
      for (const newTask of newPhase.tasks) {
        const oldTask = oldPhase?.tasks.find((task) => task.id === newTask.id)
        if (oldTask?.status === "completed" && newTask.status !== "completed") newTask.evidence = null
        if (newTask.status !== "blocked") newTask.blocker = null
      }
    }
  } else {
    for (const phase of next.phases) {
      if (phase.status !== "blocked") phase.blocker = null
      for (const task of phase.tasks) if (task.status !== "blocked") task.blocker = null
    }
  }
  const violations = [...preflightErrors, ...planValidationErrors(next)]
  if (previous) {
    if (JSON.stringify(previous.completionCriteria) !== JSON.stringify(next.completionCriteria)) {
      violations.push(planError("completionCriteria", "preserve overall completion criteria; replace the goal for a new scope"))
    }
    for (const oldPhase of previous.phases) {
      const newPhase = next.phases.find((phase) => phase.id === oldPhase.id)
      if (!newPhase) {
        if (oldPhase.status === "completed" || oldPhase.tasks.some((task) => task.status === "completed"))
          violations.push(planError(`phases[${oldPhase.id}]`, "preserve verified phase and task history"))
        else if (!revisitEvidence?.trim())
          violations.push(planError(`phases[${oldPhase.id}]`, "removing planned scope requires concrete revisit evidence"))
        continue
      }
      if (oldPhase.objective !== newPhase.objective && !revisitEvidence?.trim())
        violations.push(planError(
          `phases[${oldPhase.id}].objective`,
          "changing planned phase scope requires concrete revisit evidence",
          oldPhase.objective,
          newPhase.objective,
        ))
      if (oldPhase.status === "completed" && oldPhase.objective !== newPhase.objective)
        violations.push(planError(`phases[${oldPhase.id}].objective`, "preserve verified phase objectives"))
      if (oldPhase.status === "completed" && newPhase.status !== "completed" && !revisitEvidence?.trim()) {
        violations.push(planError(
          `phases[${oldPhase.id}].status`, "reopening a verified phase requires concrete revisit evidence",
        ))
      }
      for (const oldTask of oldPhase.tasks) {
        const newTask = newPhase.tasks.find((task) => task.id === oldTask.id)
        if (oldTask.status !== "completed") {
          if ((!newTask || newTask.description !== oldTask.description) && !revisitEvidence?.trim())
            violations.push(planError(
              `phases[${oldPhase.id}].tasks[${oldTask.id}].description`,
              "removing or changing planned task scope requires concrete revisit evidence",
              oldTask.description,
              newTask?.description,
            ))
          continue
        }
        if (!newTask || newTask.description !== oldTask.description)
          violations.push(planError(
            `phases[${oldPhase.id}].tasks[${oldTask.id}].description`,
            "preserve completed task IDs and descriptions across plan revisions",
          ))
        if (newTask && newTask.status !== "completed" && !revisitEvidence?.trim()) {
          violations.push(planError(
            `phases[${oldPhase.id}].tasks[${oldTask.id}].status`,
            "reopening a completed task requires concrete revisit evidence",
          ))
        }
      }
    }
  }
  if (violations.length) throw new Error(violations.join("\n"))
  const revision = expectedRevision + 1
  return GoalPlanSchema.parse({
    ...next,
    revision,
    updatedAt: now,
    changes: [
      ...(previous?.changes ?? []),
      {
        revision,
        reason: why,
        timestamp: now,
        ...(revisitEvidence ? { revisitEvidence: text.parse(revisitEvidence) } : {}),
      },
    ].slice(-32),
  })
}

export function goalPlanProgress(plan: GoalPlan) {
  const current =
    plan.phases.find((phase) => phase.status === "in_progress") ??
    plan.phases.find((phase) => phase.status !== "completed")
  const running = current?.tasks.find((task) => task.status === "in_progress")
  const next = current?.tasks.find((task) => task.status === "pending")
  return {
    currentPhaseID: current?.id ?? null,
    currentTaskID: running?.id ?? null,
    nextTaskID: next?.id ?? null,
    nextPhaseID: plan.phases.find((phase) => phase.id !== current?.id && phase.status !== "completed")?.id ?? null,
    completedPhaseIDs: plan.phases.filter((phase) => phase.status === "completed").map((phase) => phase.id),
    completedTaskIDs: plan.phases.flatMap((phase) =>
      phase.tasks.filter((task) => task.status === "completed").map((task) => task.id),
    ),
  }
}

/** ACP v1's plan surface is flat; retain phase boundaries in each entry's content. */
export function goalPlanEntries(plan: GoalPlan) {
  return plan.phases.flatMap((phase) =>
    phase.tasks.map((task) => ({
      content: `${phase.objective}: ${task.description}${task.blocker ? ` — Blocked: ${task.blocker}` : ""}`,
      priority: "medium" as const,
      status: task.status === "blocked" ? ("pending" as const) : task.status,
    })),
  )
}
