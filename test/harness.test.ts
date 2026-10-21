import { expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { statePath } from "../src/state-path"

test("the test run never points at the goal state of the running plugin", () => {
  // The plugin resolves the goal state from the environment on every access,
  // and the default is the goal state of the running plugin. A test run must
  // never read or write it, so the state path always points into a temporary
  // directory - both the fallback the whole run starts with and the per-test
  // directory a test file switches to.
  expect(statePath().startsWith(tmpdir())).toBe(true)
})

test("the fallback of the whole run is a temporary state file", async () => {
  const { suiteStatePath } = await import("./setup")
  expect(suiteStatePath.startsWith(join(tmpdir(), "opencode-goal-plugin-suite-"))).toBe(true)
  expect(suiteStatePath.endsWith("goals.json")).toBe(true)
})
