import { expect, test } from "bun:test"
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
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
