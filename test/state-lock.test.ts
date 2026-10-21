import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { acquireStateLock, stateLockPath } from "../src/state-lock"

let dir = ""

async function withTempDir<T>(run: (lockPath: string) => Promise<T>): Promise<T> {
  dir = await mkdtemp(join(tmpdir(), "opencode-goal-plugin-lock-"))
  try {
    return await run(stateLockPath(join(dir, "goals.json")))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test("the state lock is exclusive", async () => {
  await withTempDir(async (lockPath) => {
    const first = await acquireStateLock(lockPath)
    expect(first.held).toBe(true)

    // A second instance cannot take the lock while the first holds it.
    const second = await acquireStateLock(lockPath, { timeoutMs: 50 })
    expect(second.held).toBe(false)

    // Once the first releases it, the lock is available again.
    await first.release()
    const third = await acquireStateLock(lockPath, { timeoutMs: 50 })
    expect(third.held).toBe(true)
    await third.release()
  })
})

test("an abandoned state lock does not block the other instances", async () => {
  await withTempDir(async (lockPath) => {
    // A lock file left behind by a process that died while holding it.
    await writeFile(lockPath, "")
    const abandoned = new Date(Date.now() - 60_000)
    await utimes(lockPath, abandoned, abandoned)

    const lock = await acquireStateLock(lockPath, { timeoutMs: 100, staleMs: 30_000 })
    expect(lock.held).toBe(true)
    await lock.release()
  })
})

test("releasing a lock that was never held is safe", async () => {
  await withTempDir(async (lockPath) => {
    const lock = await acquireStateLock(lockPath, { timeoutMs: 50 })
    await lock.release()
    await lock.release()
  })
})

test("a lock failure is reported next to the state file the lock protects", async () => {
  // The lock guards one specific state file. Reporting its failure to the
  // diagnostics log of the global state file puts it in a log that a monitor
  // watches for the running plugin, and mixes unrelated failures together.
  const globalDir = await mkdtemp(join(tmpdir(), "opencode-goal-plugin-global-"))
  const previous = process.env.OPENCODE_GOAL_STATE_PATH
  process.env.OPENCODE_GOAL_STATE_PATH = join(globalDir, "goals.json")
  try {
    await withTempDir(async (lockPath) => {
      const first = await acquireStateLock(lockPath)
      expect(first.held).toBe(true)
      // A second attempt cannot take the lock and gives up.
      const second = await acquireStateLock(lockPath, { timeoutMs: 50 })
      expect(second.held).toBe(false)
      await first.release()

      // The failure is reported next to the locked state file...
      const reported = await readFile(join(dir, "goal-plugin.log"), "utf8")
      expect(reported).toContain("Gave up waiting for the state lock")
      // ...and not to the diagnostics log of the global state file.
      expect(existsSync(join(globalDir, "goal-plugin.log"))).toBe(false)
    })
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_GOAL_STATE_PATH
    else process.env.OPENCODE_GOAL_STATE_PATH = previous
    await rm(globalDir, { recursive: true, force: true })
  }
})
