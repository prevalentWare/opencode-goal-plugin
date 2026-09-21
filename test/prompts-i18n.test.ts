import { expect, test } from "bun:test"
import { continuationPrompt, limitPrompt, systemReminder } from "../src/prompts"
import type { GoalSnapshot } from "../src/state"

const promptGoal = {
  objective: "完成国际化支持",
  status: "active",
  timeUsedSeconds: 42,
  tokensUsed: 1200,
  tokenBudget: 5000,
  remainingTokens: 3800,
  autoTurns: 2,
  maxAutoTurns: 25,
  maxDurationSeconds: 1800,
  stopReason: null,
} as GoalSnapshot

test("zh-CN continuation prompt keeps goal protocol identifiers and requests Chinese replies", () => {
  const prompt = continuationPrompt(promptGoal, "zh-CN")
  expect(prompt).toContain("继续推进当前会话的活动目标")
  expect(prompt).toContain("使用简体中文")
  expect(prompt).toContain("<untrusted_objective>")
  expect(prompt).toContain("update_goal")
  expect(prompt).toContain('"complete"')
})

test("zh-CN wrap-up and system prompts are localized", () => {
  const limited = limitPrompt(
    { ...promptGoal, status: "budgetLimited", stopReason: "token budget reached" } as never,
    "zh-CN",
  )
  expect(limited).toContain("已达到安全限制")
  expect(limited).toContain("状态：预算已达上限")
  expect(limited).toContain("停止原因：已达到 Token 预算")
  expect(limited).not.toContain("状态：budgetLimited")
  expect(limited).not.toContain("停止原因：token budget reached")
  expect(limited).toContain("不要为此目标开始新的实质性工作")
  expect(limited).toContain("update_goal")

  const reminder = systemReminder("zh-CN")
  expect(reminder).toContain("OpenCode 目标模式策略")
  expect(reminder).toContain("简体中文")
  expect(reminder).toContain("get_goal")
})
