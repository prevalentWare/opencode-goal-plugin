/**
 * Test setup: point the goal state at a temporary file for the whole run.
 *
 * The state path is read from the environment every time the plugin touches
 * the goal state, and the default path is the goal state of the running
 * plugin. A test file that removes the state path when it finishes therefore
 * leaves the next file - and any work that is still in flight - with the
 * default path. A test run must never read or write the state of the running
 * plugin, and it must never write into the diagnostics log that a monitor
 * watches for it, so the path is set here for the whole run and every test
 * file restores it instead of removing it.
 */
import { mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** The directory the whole run falls back to. */
export const suiteStateDir = join(tmpdir(), `opencode-goal-plugin-suite-${process.pid}`)

/** The state path the whole run falls back to. */
export const suiteStatePath = join(suiteStateDir, "goals.json")

mkdirSync(suiteStateDir, { recursive: true })
process.env.OPENCODE_GOAL_STATE_PATH = suiteStatePath

process.on("exit", () => {
  try {
    rmSync(suiteStateDir, { recursive: true, force: true })
  } catch {
    // The operating system cleans the temporary directory up otherwise.
  }
})
