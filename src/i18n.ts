export type GoalLocale = "en" | "zh-CN"

type LocaleEnvironment = {
  LC_ALL?: string
  LANG?: string
}

export type GoalMessages = {
  commands: {
    goalDescription: string
    pauseDescription: string
    resumeDescription: string
  }
  tools: {
    getGoal: string
    getGoalHistory: string
    listAllGoals: string
    createGoal: string
    setGoal: string
    updateGoalObjective: string
    updateGoal: string
    updateGoalStatus: string
    clearGoal: string
    objective: string
    modelObjective: string
    updatedObjective: string
    tokenBudget: string
    maxAutoTurns: string
    maxDurationSeconds: string
    editStatus: string
    closeStatus: string
    evidence: string
    blocker: string
    activePausedStatus: string
  }
  notices: {
    planModeCreate: string
    limitedGoal: string
    duplicateGoal: string
    conflictingGoal: string
    restrictedGoal: string
    cannotResumeInPlan: string
  }
  reports: {
    achieved: string
    unmet: string
    timeUsed: string
    tokenUsage: string
    evidence: string
    blocker: string
    seconds: string
  }
  tui: {
    title: string
    commandDescription: string
    refresh: string
    refreshDescription: string
    history: string
    historyDescription: string
    pause: string
    pauseDescription: string
    resume: string
    resumeDescription: string
    clear: string
    clearDescription: string
    refreshPrompt: string
    historyPrompt: string
    pausePrompt: string
    resumePrompt: string
    clearPrompt: string
    openSession: string
    noGoal: string
    objective: string
    status: string
    timeUsed: string
    time: string
    tokens: string
    autoContinues: string
    tokensRemaining: string
    durationLimit: string
    noProgressTurns: string
    latestCheckpoint: string
    checkpoint: string
    stopReason: string
    stop: string
    lastStatus: string
    completionEvidence: string
    blocker: string
    achieved: string
    unmet: string
  }
}

const EN_MESSAGES: GoalMessages = {
  commands: {
    goalDescription: "Set or view the long-running session goal",
    pauseDescription: "Pause the current long-running session goal",
    resumeDescription: "Resume the current long-running session goal",
  },
  tools: {
    getGoal:
      "Get the current goal for this OpenCode session, including status, observed token usage, elapsed-time usage, " +
      "budgets, checkpoints, and history.",
    getGoalHistory: "Get the current goal lifecycle history and recent checkpoints for this OpenCode session.",
    listAllGoals:
      "List up to 50 public goal summaries across all sessions in this state file, ordered by most recently updated " +
      "first. Elapsed time is the last persisted value; total and truncated report omitted older goals.",
    createGoal:
      "Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals " +
      "from ordinary tasks. If any non-closed goal exists, this returns the existing goal as either reused or " +
      "conflicting and must not be retried. While the session is in Plan mode, the goal is recorded as paused and " +
      "execution requires the user to switch to Build mode.",
    setGoal:
      "Set a new goal when the user explicitly asks the agent to formulate and set its own goal. The model should " +
      "write the objective itself based on the user's explicit request. If any non-closed goal exists, this returns " +
      "the existing goal as either reused or conflicting and must not be retried. While the session is in Plan mode, " +
      "the goal is recorded as paused and execution requires the user to switch to Build mode.",
    updateGoalObjective: "Edit the current OpenCode goal objective when the user explicitly asks to edit or replace it.",
    updateGoal:
      "Close the existing goal only after an audit against real evidence. Use status complete only when the objective " +
      "is achieved and no required work remains, and include evidence. Use status unmet only when the objective " +
      "cannot be achieved or is blocked, and include the blocker. Do not close a goal merely because work is stopping.",
    updateGoalStatus:
      "Pause or resume the current OpenCode goal when the user explicitly asks to pause or resume it. Resuming is not " +
      "allowed while the session is in Plan mode; the user must switch to Build mode first.",
    clearGoal: "Clear the current OpenCode goal for this session when the user explicitly asks to clear it.",
    objective: "The concrete objective to start pursuing.",
    modelObjective: "The model-formulated concrete objective to start pursuing.",
    updatedObjective: "The updated concrete objective.",
    tokenBudget: "Optional positive token budget.",
    maxAutoTurns: "Optional per-goal auto-continue limit.",
    maxDurationSeconds: "Optional per-goal duration limit.",
    editStatus: "Whether the edited goal should be active or paused.",
    closeStatus: "Required. complete means achieved; unmet means blocked or impossible.",
    evidence: "Required when status is complete. Summarize the concrete evidence verified.",
    blocker: "Required when status is unmet. Explain the concrete blocker or impossibility.",
    activePausedStatus: "active resumes a goal; paused pauses it without clearing it.",
  },
  notices: {
    planModeCreate:
      "Goal recorded while the session is in Plan mode, so execution is paused. Do not start implementation work " +
      'now. Ask the user to switch to Build mode and resume the goal (for example with "/goal resume") to begin execution.',
    limitedGoal:
      "Safety limit reached. Do not start or continue substantive work for this goal. Summarize useful progress, " +
      "remaining work, and blockers, then wait for the user to resume or edit the goal.",
    duplicateGoal:
      "This non-closed goal already exists. Do not call create_goal or set_goal again. The existing objective and " +
      "limits were preserved; repeated-call arguments were not applied. Use the returned goal state and continue only " +
      "when its status permits execution.",
    conflictingGoal:
      "A different non-closed goal already exists. Do not call create_goal or set_goal again. Report the conflict " +
      "instead of replacing the goal; edit, clear, complete, or mark it unmet only when explicitly requested.",
    restrictedGoal:
      "Goal execution is not allowed from the current restricted agent or while the goal is paused for Plan mode. " +
      "Switch to Build mode and resume the goal before doing substantive work.",
    cannotResumeInPlan:
      "cannot resume the goal while the session is in Plan mode; ask the user to switch to Build mode and resume the " +
      "goal from there",
  },
  reports: {
    achieved: "Goal achieved.",
    unmet: "Goal unmet.",
    timeUsed: "Time used",
    tokenUsage: "Token usage",
    evidence: "Evidence",
    blocker: "Blocker",
    seconds: "seconds",
  },
  tui: {
    title: "Goal",
    commandDescription: "View, pause, resume, or clear the long-running session goal",
    refresh: "Refresh",
    refreshDescription: "Ask the agent to read the current goal state",
    history: "History",
    historyDescription: "Ask the agent to show lifecycle history",
    pause: "Pause",
    pauseDescription: "Pause auto-continuation without clearing",
    resume: "Resume",
    resumeDescription: "Resume the goal and continue",
    clear: "Clear",
    clearDescription: "Ask the agent to clear this session goal",
    refreshPrompt: "Call get_goal for this session and report the current goal state briefly.",
    historyPrompt: "Call get_goal_history for this session and report the current goal history briefly.",
    pausePrompt: 'Pause the current session goal by calling update_goal_status with status "paused". Report the result briefly.',
    resumePrompt:
      'Resume the current session goal by calling update_goal_status with status "active", then continue working toward it.',
    clearPrompt: "Clear the current session goal by calling clear_goal. Report whether a goal was cleared.",
    openSession: "Open a session before viewing goal state.",
    noGoal: "No recent goal state found in this session.",
    objective: "Objective",
    status: "Status",
    timeUsed: "Time used",
    time: "Time",
    tokens: "Tokens",
    autoContinues: "Auto-continues",
    tokensRemaining: "Tokens remaining",
    durationLimit: "Duration limit",
    noProgressTurns: "No-progress turns",
    latestCheckpoint: "Latest checkpoint",
    checkpoint: "Checkpoint",
    stopReason: "Stop reason",
    stop: "Stop",
    lastStatus: "Last status",
    completionEvidence: "Completion evidence",
    blocker: "Blocker",
    achieved: "Goal achieved",
    unmet: "Goal unmet",
  },
}

const ZH_CN_MESSAGES: GoalMessages = {
  commands: {
    goalDescription: "设置或查看当前会话的长期目标",
    pauseDescription: "暂停当前会话的长期目标",
    resumeDescription: "继续当前会话的长期目标",
  },
  tools: {
    getGoal: "获取当前 OpenCode 会话的目标，包括状态、已观察到的 token 使用量、已用时间、预算、检查点和历史记录。",
    getGoalHistory: "获取当前 OpenCode 会话的目标生命周期历史和最近的检查点。",
    listAllGoals:
      "列出此状态文件中所有会话里最近更新的最多 50 个公开目标摘要。已用时间采用最后一次持久化的值；total 和 truncated 字段用于说明是否省略了更早的目标。",
    createGoal:
      "仅当用户或 system/developer 指令明确要求时创建目标，不要从普通任务中推断目标。" +
      "如果已有未关闭目标，则返回该目标并标记为复用或冲突，不得重试。" +
      "在 Plan 模式下创建目标时，目标会以暂停状态记录；用户切换到 Build 模式后才能执行。",
    setGoal:
      "仅当用户明确要求 Agent 自行制定并设置目标时创建新目标。模型应依据用户的明确请求自行撰写目标。" +
      "如果已有未关闭目标，则返回该目标并标记为复用或冲突，不得重试。" +
      "在 Plan 模式下创建目标时，目标会以暂停状态记录；用户切换到 Build 模式后才能执行。",
    updateGoalObjective: "仅当用户明确要求编辑或替换目标时，修改当前 OpenCode 目标的内容。",
    updateGoal:
      "只有在依据真实证据完成审计后才能关闭现有目标。仅当目标已经达成且没有剩余必需工作时使用 complete，并提供证据；仅当目标无法达成或被阻塞时使用 unmet，并提供阻塞原因。不要仅因为准备停止工作就关闭目标。",
    updateGoalStatus:
      "仅当用户明确要求暂停或继续目标时，暂停或继续当前 OpenCode 目标。在 Plan 模式下不能继续目标；用户必须先切换到 Build 模式。",
    clearGoal: "仅当用户明确要求清除目标时，清除当前 OpenCode 会话的目标。",
    objective: "要开始执行的具体目标。",
    modelObjective: "由模型制定、要开始执行的具体目标。",
    updatedObjective: "更新后的具体目标。",
    tokenBudget: "可选的正数 token 预算。",
    maxAutoTurns: "可选的单目标自动继续次数上限。",
    maxDurationSeconds: "可选的单目标持续时间上限。",
    editStatus: "编辑后的目标应处于 active 还是 paused 状态。",
    closeStatus: "必填。complete 表示已达成；unmet 表示被阻塞或无法完成。",
    evidence: "status 为 complete 时必填。概述已核验的具体证据。",
    blocker: "status 为 unmet 时必填。说明具体阻塞原因或无法完成的原因。",
    activePausedStatus: "active 表示继续目标；paused 表示暂停但不清除目标。",
  },
  notices: {
    planModeCreate:
      '目标已在 Plan 模式下记录，因此执行被暂停。现在不要开始实现工作。请让用户切换到 Build 模式并继续目标（例如使用 "/goal resume"）后再开始执行。',
    limitedGoal:
      "已达到安全限制。不要开始或继续此目标的实质性工作。请总结已有进展、剩余工作和阻塞项，然后等待用户继续或编辑目标。",
    duplicateGoal:
      "这个未关闭目标已经存在。不要再次调用 create_goal 或 set_goal。现有目标内容和限制已保留，重复调用的参数没有应用。请使用返回的目标状态，并且只在其状态允许执行时继续。",
    conflictingGoal:
      "已有另一个未关闭目标。不要再次调用 create_goal 或 set_goal，也不要替换现有目标；请报告冲突。只有在用户明确要求时，才可编辑、清除、完成目标或将其标记为 unmet。",
    restrictedGoal:
      "当前受限 Agent 或 Plan 模式暂停状态不允许执行目标。请先切换到 Build 模式并继续目标，再进行实质性工作。",
    cannotResumeInPlan: "会话处于 Plan 模式时不能继续目标；请让用户切换到 Build 模式后再继续该目标",
  },
  reports: {
    achieved: "目标已达成。",
    unmet: "目标未达成。",
    timeUsed: "已用时间",
    tokenUsage: "Token 使用量",
    evidence: "证据",
    blocker: "阻塞原因",
    seconds: "秒",
  },
  tui: {
    title: "目标",
    commandDescription: "查看、暂停、继续或清除当前会话的长期目标",
    refresh: "刷新",
    refreshDescription: "让 Agent 读取当前目标状态",
    history: "历史",
    historyDescription: "让 Agent 显示目标生命周期历史",
    pause: "暂停",
    pauseDescription: "暂停自动继续，但不清除目标",
    resume: "继续",
    resumeDescription: "继续目标并接着执行",
    clear: "清除",
    clearDescription: "让 Agent 清除当前会话目标",
    refreshPrompt: "调用 get_goal 获取此会话的当前目标，并用简体中文简要报告目标状态。",
    historyPrompt: "调用 get_goal_history 获取此会话的当前目标历史，并用简体中文简要报告。",
    pausePrompt: '调用 update_goal_status 并将 status 设为 "paused"，暂停当前会话目标。用简体中文简要报告结果。',
    resumePrompt:
      '调用 update_goal_status 并将 status 设为 "active"，继续当前会话目标，然后继续推进该目标。请使用简体中文回复用户。',
    clearPrompt: "调用 clear_goal 清除当前会话目标，并用简体中文报告是否成功清除了目标。",
    openSession: "请先打开一个会话，再查看目标状态。",
    noGoal: "此会话中没有最近的目标状态。",
    objective: "目标",
    status: "状态",
    timeUsed: "已用时间",
    time: "时间",
    tokens: "Token",
    autoContinues: "自动继续次数",
    tokensRemaining: "剩余 Token",
    durationLimit: "持续时间上限",
    noProgressTurns: "无进展轮数",
    latestCheckpoint: "最新检查点",
    checkpoint: "检查点",
    stopReason: "停止原因",
    stop: "停止",
    lastStatus: "最近状态",
    completionEvidence: "完成证据",
    blocker: "阻塞原因",
    achieved: "目标已达成",
    unmet: "目标未达成",
  },
}

function normalizeLocaleCandidate(value: string | null | undefined): GoalLocale | null {
  if (!value?.trim()) return null
  const normalized = value.trim().replaceAll("_", "-").split(".")[0]!.split("@")[0]!.toLowerCase()
  if (normalized === "c" || normalized === "posix") return null
  if (normalized === "zh" || normalized.startsWith("zh-")) return "zh-CN"
  if (normalized === "en" || normalized.startsWith("en-")) return "en"
  return null
}

function processEnvironment(): LocaleEnvironment {
  if (typeof process === "undefined") return {}
  return {
    LC_ALL: process.env.LC_ALL,
    LANG: process.env.LANG,
  }
}

function systemLocale() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale
  } catch {
    return undefined
  }
}

export function resolveLocale(
  explicit?: string | null,
  environment: LocaleEnvironment = processEnvironment(),
  osLocale: string | undefined = systemLocale(),
): GoalLocale {
  const configured = explicit?.trim()
  if (!configured) return "en"
  if (configured.toLowerCase() !== "auto") return normalizeLocaleCandidate(configured) ?? "en"

  for (const candidate of [environment.LC_ALL, environment.LANG, osLocale]) {
    const locale = normalizeLocaleCandidate(candidate)
    if (locale) return locale
  }
  return "en"
}

export function messagesFor(locale: GoalLocale): GoalMessages {
  return locale === "zh-CN" ? ZH_CN_MESSAGES : EN_MESSAGES
}

const STATUS_PRESENTATIONS: Record<GoalLocale, Record<string, string>> = {
  en: {
    active: "active",
    paused: "paused",
    budgetLimited: "budget limited",
    usageLimited: "usage limited",
    complete: "complete",
    unmet: "unmet",
  },
  "zh-CN": {
    active: "进行中",
    paused: "已暂停",
    budgetLimited: "预算已达上限",
    usageLimited: "使用量已达上限",
    complete: "已完成",
    unmet: "未达成",
  },
}

/** Formats protocol status values only at user-facing presentation boundaries. */
export function presentGoalStatus(status: string, locale: GoalLocale): string {
  return STATUS_PRESENTATIONS[locale][status] ?? status
}

/**
 * Formats stop reasons produced by this plugin. Unknown values are user-authored
 * or externally supplied text and must be returned verbatim.
 */
export function presentGoalStopReason(reason: string, locale: GoalLocale): string {
  if (locale !== "zh-CN") return reason

  const direct: Record<string, string> = {
    paused: "已暂停",
    blocked: "已阻塞",
    "plan mode": "Plan 模式",
    "no progress": "无进展",
    "auto-continue failures": "自动继续失败",
    "goal limit reached": "已达到目标限制",
    "token budget reached": "已达到 Token 预算",
    "max auto-continues reached": "已达到自动继续次数上限",
    "max duration reached": "已达到持续时间上限",
  }
  if (direct[reason]) return direct[reason]

  const tokenBudget = /^token budget reached \((\d+)\/(\d+)\)$/.exec(reason)
  if (tokenBudget) return `已达到 Token 预算（${tokenBudget[1]}/${tokenBudget[2]}）`
  const autoContinues = /^max auto-continues reached \((\d+)\)$/.exec(reason)
  if (autoContinues) return `已达到自动继续次数上限（${autoContinues[1]}）`
  const duration = /^max duration reached \((\d+)s\)$/.exec(reason)
  if (duration) return `已达到持续时间上限（${duration[1]} 秒）`
  return reason
}

/**
 * Formats status text generated by this plugin. Unknown text can come from a
 * user-authored blocker, checkpoint, or older plugin and stays byte-for-byte
 * intact at the presentation boundary.
 */
export function presentGoalLastStatus(status: string, locale: GoalLocale): string {
  if (locale !== "zh-CN") return status

  const direct: Record<string, string> = {
    "Goal set.": "目标已设置。",
    "Goal recorded from Plan mode; execution paused until resumed from Build mode.":
      "目标已在 Plan 模式下记录；执行已暂停，需在 Build 模式下继续。",
    "Goal objective updated; execution paused while the session is in Plan mode.":
      "目标内容已更新；会话处于 Plan 模式，因此执行已暂停。",
    "Goal objective updated and resumed.": "目标内容已更新并继续执行。",
    "Goal objective updated and paused.": "目标内容已更新并暂停。",
    "Auto-continue paused while the session is in Plan mode.": "会话处于 Plan 模式，因此自动继续已暂停。",
    "Goal resumed.": "目标已继续。",
    "Goal paused.": "目标已暂停。",
    "Goal completed.": "目标已完成。",
    "Goal marked unmet.": "目标已标记为未达成。",
    "Auto-continue attempt canceled before delivery.": "自动继续尝试已在发送前取消。",
    "Auto-continue prompt sent.": "自动继续提示已发送。",
    "Auto-continue prompt failed repeatedly. Resume the goal to retry.": "自动继续提示反复失败。请继续目标后重试。",
    "Goal execution is paused while the session is in Plan mode. Switch to Build mode and resume the goal to continue.":
      "会话处于 Plan 模式，因此目标执行已暂停。请切换到 Build 模式并继续目标。",
  }
  if (direct[status]) return direct[status]

  const lowProgressPausePattern =
    /^Auto-continue paused after (\d+) low-progress continuation turn\(s\)\. Resume the goal to retry\.$/
  const lowProgressPause = lowProgressPausePattern.exec(status)
  if (lowProgressPause) return `自动继续已在 ${lowProgressPause[1]} 个低进展轮次后暂停。请继续目标后重试。`

  const lowProgress = /^Low-progress continuation turn detected \((\d+)\/(\d+|unbounded)\)\.$/.exec(status)
  if (lowProgress) {
    const limit = lowProgress[2] === "unbounded" ? "不限" : lowProgress[2]
    return `检测到低进展的继续轮次（${lowProgress[1]}/${limit}）。`
  }

  const reserved = /^Auto-continue (\d+) reserved\.$/.exec(status)
  if (reserved) return `已预留第 ${reserved[1]} 次自动继续。`
  const failed = /^Auto-continue failed (\d+) time\(s\)\.$/.exec(status)
  if (failed) return `自动继续已失败 ${failed[1]} 次。`
  const pausedAfterFailures = /^Paused after (\d+) auto-continue failure\(s\)\.$/.exec(status)
  if (pausedAfterFailures) return `已在 ${pausedAfterFailures[1]} 次自动继续失败后暂停。`

  const wrapUp = /^(.*); wrap-up required\.$/.exec(status)
  if (wrapUp) return `${presentGoalStopReason(wrapUp[1]!, locale)}；需要收尾。`
  return status
}

const HISTORY_TYPE_PRESENTATIONS: Record<GoalLocale, Record<string, string>> = {
  en: {},
  "zh-CN": {
    created: "已创建",
    updated: "已更新",
    paused: "已暂停",
    resumed: "已继续",
    completed: "已完成",
    unmet: "未达成",
    autoContinue: "自动继续",
    checkpoint: "检查点",
    warning: "警告",
    limited: "已受限",
    error: "错误",
  },
}

export function presentGoalHistoryType(type: string, locale: GoalLocale): string {
  return HISTORY_TYPE_PRESENTATIONS[locale][type] ?? type
}

/** Localizes only plugin-owned history framing and preserves embedded user text. */
export function presentGoalHistoryDetail(detail: string, locale: GoalLocale): string {
  if (locale !== "zh-CN") return detail
  const lastStatus = presentGoalLastStatus(detail, locale)
  if (lastStatus !== detail) return lastStatus

  if (detail === "Goal set with default continuation limits.") return "目标已按默认继续限制设置。"
  const objectiveUpdate = /^Goal objective updated: (.*)$/.exec(detail)
  if (objectiveUpdate) return `目标内容已更新：${objectiveUpdate[1]}`

  const configuredLimits = /^Goal set with (.*)\.$/.exec(detail)
  if (configuredLimits) {
    const limits = configuredLimits[1]!
      .split(", ")
      .map((value) => {
        const tokenBudget = /^(\d+) token budget$/.exec(value)
        if (tokenBudget) return `Token 预算 ${tokenBudget[1]}`
        const autoContinues = /^(\d+) auto-continue limit$/.exec(value)
        if (autoContinues) return `自动继续次数上限 ${autoContinues[1]}`
        const duration = /^(\d+)s duration limit$/.exec(value)
        if (duration) return `持续时间上限 ${duration[1]} 秒`
        return value
      })
      .join("，")
    return `目标已设置，限制为：${limits}。`
  }

  const finalHandoff = /^(\w+): (.*); requested final handoff\.$/.exec(detail)
  if (finalHandoff) {
    return `${presentGoalStatus(finalHandoff[1]!, locale)}：${presentGoalStopReason(finalHandoff[2]!, locale)}；已请求最终交接。`
  }
  return detail
}

type PresentableGoalHistory = {
  history: Array<{ type: string; detail: string; timestamp: number }>
}

export function formatGoalHistoryPresentation(goal: PresentableGoalHistory | null, locale: GoalLocale): string {
  if (!goal) return locale === "zh-CN" ? "此会话没有可用的目标历史。" : "No goal history is available for this session."
  if (goal.history.length === 0) return locale === "zh-CN" ? "尚未记录目标历史。" : "No goal history recorded yet."
  return goal.history
    .map((entry) => {
      const timestamp = new Date(entry.timestamp * 1000).toISOString()
      const type = presentGoalHistoryType(entry.type, locale)
      const detail = presentGoalHistoryDetail(entry.detail, locale)
      return `- [${timestamp}] ${type}: ${detail}`
    })
    .join("\n")
}
