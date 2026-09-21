import { expect, test } from "bun:test"
import {
  messagesFor,
  presentGoalHistoryDetail,
  presentGoalHistoryType,
  presentGoalLastStatus,
  resolveLocale,
} from "../src/i18n"

test("explicit locale overrides environment and OS locale", () => {
  expect(resolveLocale("zh-CN", { LANG: "en_US.UTF-8" }, "en-US")).toBe("zh-CN")
  expect(resolveLocale("en", { LC_ALL: "zh_CN.UTF-8" }, "zh-CN")).toBe("en")
})

test("default locale remains English regardless of environment", () => {
  expect(resolveLocale(undefined, { LC_ALL: "zh_CN.UTF-8", LANG: "zh_CN.UTF-8" }, "zh-CN")).toBe("en")
})

test("auto locale detection prefers LC_ALL, then LANG, then OS locale", () => {
  expect(resolveLocale("auto", { LC_ALL: "zh_CN.UTF-8", LANG: "en_US.UTF-8" }, "en-US")).toBe("zh-CN")
  expect(resolveLocale("auto", { LANG: "zh_CN.UTF-8" }, "en-US")).toBe("zh-CN")
  expect(resolveLocale("auto", {}, "zh-CN")).toBe("zh-CN")
})

test("unsupported explicit locales fall back to English", () => {
  expect(resolveLocale("fr-FR", { LANG: "zh_CN.UTF-8" }, "zh-CN")).toBe("en")
  expect(resolveLocale("auto", { LANG: "C.UTF-8" }, "en-US")).toBe("en")
})

test("zh-CN messages localize user-facing goal strings without changing tool identifiers", () => {
  const messages = messagesFor("zh-CN")
  expect(messages.commands.goalDescription).toContain("目标")
  expect(messages.tools.createGoal).toContain("创建目标")
  expect(messages.tui.refresh).toBe("刷新")
  expect(messages.tui.refreshPrompt).toContain("get_goal")
})

test("zh-CN presents every plugin-owned last-status shape and preserves unknown text", () => {
  const cases = [
    ["Goal set.", "目标已设置。"],
    ["Goal paused.", "目标已暂停。"],
    ["Goal completed.", "目标已完成。"],
    ["Auto-continue 3 reserved.", "已预留第 3 次自动继续。"],
    ["Auto-continue failed 2 time(s).", "自动继续已失败 2 次。"],
    ["Paused after 2 auto-continue failure(s).", "已在 2 次自动继续失败后暂停。"],
    ["Low-progress continuation turn detected (1/unbounded).", "检测到低进展的继续轮次（1/不限）。"],
    ["token budget reached (12/10); wrap-up required.", "已达到 Token 预算（12/10）；需要收尾。"],
  ] as const
  for (const [source, expected] of cases) expect(presentGoalLastStatus(source, "zh-CN")).toBe(expected)

  const userText = "User says: do not translate this <tag>"
  expect(presentGoalLastStatus(userText, "zh-CN")).toBe(userText)
})

test("zh-CN localizes history framing while preserving embedded user content", () => {
  expect(presentGoalHistoryType("autoContinue", "zh-CN")).toBe("自动继续")
  expect(presentGoalHistoryDetail("Goal objective updated: Keep THIS unchanged", "zh-CN")).toBe(
    "目标内容已更新：Keep THIS unchanged",
  )
  expect(presentGoalHistoryDetail("checkpoint text from user", "zh-CN")).toBe("checkpoint text from user")
})
