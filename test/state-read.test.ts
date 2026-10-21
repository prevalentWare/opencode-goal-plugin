import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  MISSING_READ_ATTEMPTS,
  READ_ATTEMPTS,
  READ_RETRY_DELAY_MS,
  isTransientReadError,
  readStateFile,
  type StateReadOps,
} from "../src/state-read"

function errno(code: string, message: string) {
  const error = new Error(message) as NodeJS.ErrnoException
  error.code = code
  return error
}

function makeOps(readFile: StateReadOps["readFile"], platform: NodeJS.Platform = "win32"): StateReadOps {
  return { platform, readFile, sleep: async () => {} }
}

test("a transient missing file is retried", async () => {
  // The rename that replaces the state file is not atomic on Windows, so a
  // concurrent reader can find the file momentarily missing.
  let attempts = 0
  const ops = makeOps(async (path) => {
    attempts += 1
    if (attempts === 1) throw errno("ENOENT", "no such file")
    return await import("node:fs/promises").then((fs) => fs.readFile(path, "utf8"))
  })
  const dir = await mkdtemp(join(tmpdir(), "opencode-goal-plugin-read-"))
  try {
    const file = join(dir, "goals.json")
    await writeFile(file, "payload")
    expect(await readStateFile(file, ops)).toBe("payload")
    expect(attempts).toBe(2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("a transient lock failure is retried", async () => {
  let attempts = 0
  const ops = makeOps(async (path) => {
    attempts += 1
    if (attempts === 1) throw errno("EPERM", "operation not permitted")
    return await import("node:fs/promises").then((fs) => fs.readFile(path, "utf8"))
  })
  const dir = await mkdtemp(join(tmpdir(), "opencode-goal-plugin-read-"))
  try {
    const file = join(dir, "goals.json")
    await writeFile(file, "payload")
    expect(await readStateFile(file, ops)).toBe("payload")
    expect(attempts).toBe(2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("a genuine failure is not retried", async () => {
  let attempts = 0
  const ops = makeOps(async () => {
    attempts += 1
    throw errno("EIO", "input/output error")
  })
  await expect(readStateFile("C:/nowhere/goals.json", ops)).rejects.toThrow()
  expect(attempts).toBe(1)
})

test("a persistent transient failure gives up after the budget", async () => {
  let attempts = 0
  const ops = makeOps(async () => {
    attempts += 1
    throw errno("EPERM", "operation not permitted")
  })
  await expect(readStateFile("C:/nowhere/goals.json", ops)).rejects.toThrow()
  expect(attempts).toBe(READ_ATTEMPTS)
})

test("transient read errors are classified per platform", () => {
  expect(isTransientReadError(errno("ENOENT", "gone"), "win32")).toBe(true)
  expect(isTransientReadError(errno("EPERM", "denied"), "win32")).toBe(true)
  expect(isTransientReadError(errno("EPERM", "denied"), "linux")).toBe(false)
  expect(isTransientReadError(errno("EIO", "io"), "win32")).toBe(false)
  expect(READ_RETRY_DELAY_MS).toBeGreaterThan(0)
})

test("a genuinely missing file is not retried for long", async () => {
  // A file that is missing is a normal state for a fresh install, so the
  // retries have to be short: a long wait delays the first write enough to
  // reorder the events around it.
  let attempts = 0
  const ops = makeOps(async () => {
    attempts += 1
    throw errno("ENOENT", "no such file")
  })
  await expect(readStateFile("C:/nowhere/goals.json", ops)).rejects.toThrow()
  expect(attempts).toBe(MISSING_READ_ATTEMPTS)
})