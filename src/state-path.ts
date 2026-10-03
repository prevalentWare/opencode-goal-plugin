import { homedir } from "node:os"
import { join } from "node:path"

export function statePath() {
  if (process.env.OPENCODE_GOAL_STATE_PATH) return process.env.OPENCODE_GOAL_STATE_PATH
  const dataHome =
    process.env.XDG_DATA_HOME ||
    (process.platform === "win32" && process.env.APPDATA ? process.env.APPDATA : join(homedir(), ".local", "share"))
  return join(dataHome, "opencode-goal-plugin", "goals.json")
}
