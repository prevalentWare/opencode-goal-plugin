import { expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Cause, Effect } from "effect-goal-state"
import { describeError, diagnosticsLogPath, reportPluginError } from "../src/diagnostics"
import { createGoal, onStateRecovery } from "../src/state"

let dir = ""

async function withStatePath<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.OPENCODE_GOAL_STATE_PATH
  dir = await mkdtemp(join(tmpdir(), "opencode-goal-plugin-diagnostics-"))
  process.env.OPENCODE_GOAL_STATE_PATH = join(dir, "goals.json")
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_GOAL_STATE_PATH
    else process.env.OPENCODE_GOAL_STATE_PATH = previous
    await rm(dir, { recursive: true, force: true })
  }
}

test("a reported plugin error is written next to the goal state file", async () => {
  await withStatePath(async () => {
    reportPluginError("Turn watchdog retry failed", new Error("provider unreachable"))
    const contents = await readFile(diagnosticsLogPath(), "utf8")
    expect(contents).toContain("Turn watchdog retry failed")
    expect(contents).toContain("provider unreachable")
    expect(contents).toContain("| error |")
  })
})

test("an explicit state file selects its log instead of the ambient state", async () => {
  await withStatePath(async () => {
    const file = join(dir, "explicit", "goals.json")
    reportPluginError("explicit owner", new Error("owner failure"), file)

    expect(diagnosticsLogPath(file)).toBe(join(dir, "explicit", "goal-plugin.log"))
    expect(await Bun.file(join(dir, "explicit", "goal-plugin.log")).exists()).toBe(true)
    expect(await readFile(join(dir, "explicit", "goal-plugin.log"), "utf8")).toContain("owner failure")
    expect(await Bun.file(join(dir, "goal-plugin.log")).exists()).toBe(false)
  })
})

test("state files in the same directory share the diagnostic log", async () => {
  await withStatePath(async () => {
    const first = join(dir, "shared", "first.json")
    const second = join(dir, "shared", "second.json")
    reportPluginError("first owner", undefined, first)
    reportPluginError("second owner", undefined, second)

    const contents = await readFile(join(dir, "shared", "goal-plugin.log"), "utf8")
    expect(contents).toContain("first owner")
    expect(contents).toContain("second owner")
    expect(await Bun.file(join(dir, "goal-plugin.log")).exists()).toBe(false)
  })
})

test("a rejected recovery listener logs beside its captured state after the environment changes", async () => {
  await withStatePath(async () => {
    const file = join(dir, "goals.json")
    const otherFile = join(dir, "other", "goals.json")
    await mkdir(join(dir, "other"))
    await writeFile(file, "\0".repeat(32))
    const stop = onStateRecovery(file, async () => {
      await Promise.resolve()
      process.env.OPENCODE_GOAL_STATE_PATH = otherFile
      throw new Error("recovery listener failure")
    })
    try {
      await createGoal("diagnostics-recovery", "Recover the isolated state", null)
      await new Promise<void>((resolve) => setImmediate(resolve))

      expect(await Bun.file(join(dir, "goal-plugin.log")).exists()).toBe(true)
      const contents = await readFile(join(dir, "goal-plugin.log"), "utf8")
      expect(contents).toContain("Failed to report quarantined state")
      expect(contents).toContain("recovery listener failure")
      expect(await Bun.file(join(dir, "other", "goal-plugin.log")).exists()).toBe(false)
      expect(JSON.parse(await readFile(file, "utf8")).goals["diagnostics-recovery"].objective)
        .toBe("Recover the isolated state")
    } finally {
      stop()
    }
  })
})

test("a reported plugin error without a cause is still recorded", async () => {
  await withStatePath(async () => {
    reportPluginError("V2 event consumer stopped")
    const contents = await readFile(diagnosticsLogPath(), "utf8")
    expect(contents).toContain("V2 event consumer stopped")
  })
})

test("repeated reports append one line each", async () => {
  await withStatePath(async () => {
    reportPluginError("first", new Error("one"))
    reportPluginError("second", new Error("two"))
    const contents = await readFile(diagnosticsLogPath(), "utf8")
    const lines = contents.trim().split("\n")
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain("first")
    expect(lines[1]).toContain("second")
  })
})

test("reporting a plugin error never throws", async () => {
  await withStatePath(async () => {
    const blocked = join(dir, "blocked")
    await writeFile(blocked, "regular file")
    process.env.OPENCODE_GOAL_STATE_PATH = join(blocked, "goals.json")
    expect(() => reportPluginError("still reported")).not.toThrow()
    expect(await readFile(blocked, "utf8")).toBe("regular file")
  })
})

test("the error description unwraps the cause chain", () => {
  // The state layer reports failures through Effect, so the error that reaches
  // a caller is a FiberFailure whose own message says nothing. The cause chain
  // holds the real reason.
  const inner = new Error("EPERM: operation not permitted, rename")
  const tagged = Object.assign(new Error("An error has occurred"), { _tag: "StateWriteError", cause: inner })
  const description = describeError(tagged)
  expect(description).toContain("StateWriteError")
  expect(description).toContain("EPERM")
})

test("the error description stops at a bounded depth", () => {
  let error: unknown = new Error("root cause")
  for (let depth = 0; depth < 20; depth++) error = { cause: error }
  expect(describeError(error)).toContain("...")
  expect(describeError(error)).not.toContain("root cause")
})

test("the error description unwraps a real Effect fiber failure", async () => {
  // Use a real state-layer fiber failure rather than imitating Effect internals.
  let failure: unknown
  try {
    Effect.runSync(Effect.fail(new Error("EPERM: rename failed")))
  } catch (error) {
    failure = error
  }
  expect(failure).toBeDefined()
  const description = describeError(failure)
  expect(description).toContain("EPERM")
  expect(description).toContain("rename failed")
})

for (const { name, combine } of [
  { name: "parallel", combine: Cause.parallel },
  { name: "sequential", combine: Cause.sequential },
]) {
  test(`both errors survive a real Effect ${name} cause`, () => {
    let failure: unknown
    try {
      Effect.runSync(Effect.failCause(combine(Cause.fail(new Error("ROOT_LEFT")), Cause.die(new Error("ROOT_RIGHT")))))
    } catch (error) {
      failure = error
    }
    expect(describeError(failure)).toContain("ROOT_LEFT")
    expect(describeError(failure)).toContain("ROOT_RIGHT")
  })
}

test.skipIf(process.platform === "win32")("diagnostics use owner-only permissions, including an existing log", async () => {
  await withStatePath(async () => {
    process.env.OPENCODE_GOAL_STATE_PATH = join(dir, "private", "goals.json")
    const previous = process.umask(0o022)
    try {
      reportPluginError("private event")
      const file = diagnosticsLogPath()
      expect((await stat(join(dir, "private"))).mode & 0o777).toBe(0o700)
      expect((await stat(file)).mode & 0o777).toBe(0o600)
      await chmod(file, 0o644)
      await writeFile(`${file}.1`, "legacy archive", { mode: 0o644 })
      reportPluginError("secure the existing log")
      expect((await stat(file)).mode & 0o777).toBe(0o600)
      expect((await stat(`${file}.1`)).mode & 0o777).toBe(0o600)
    } finally {
      process.umask(previous)
    }
  })
})

test("rotation preserves one bounded archive and starts a fresh log", async () => {
  await withStatePath(async () => {
    const file = diagnosticsLogPath()
    const previous = "x".repeat(1024 * 1024 - 16)
    await writeFile(file, previous)
    await writeFile(`${file}.1`, "older archive")
    reportPluginError("new event after rotation")
    expect(await readFile(`${file}.1`, "utf8")).toBe(previous)
    expect(await readFile(file, "utf8")).toContain("new event after rotation")
    expect((await stat(file)).size).toBeLessThanOrEqual(1024 * 1024)
    if (process.platform !== "win32") expect((await stat(`${file}.1`)).mode & 0o777).toBe(0o600)
  })
})

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "failed rename drops incoming events without growing the log or deleting its archive", async () => {
  await withStatePath(async () => {
    const file = diagnosticsLogPath()
    await writeFile(file, "x".repeat(1024 * 1024))
    await writeFile(`${file}.1`, "previous archive")
    await chmod(dir, 0o500)
    try {
      for (let attempt = 0; attempt < 3; attempt++) reportPluginError("rotation cannot write its directory")
      expect((await stat(file)).size).toBe(1024 * 1024)
      expect(await readFile(`${file}.1`, "utf8")).toBe("previous archive")
    } finally {
      await chmod(dir, 0o700)
    }
  })
})

test.skipIf(process.platform === "win32")("a planted log symlink never changes its target", async () => {
  await withStatePath(async () => {
    const target = join(dir, "unrelated")
    await writeFile(target, "preserve", { mode: 0o644 })
    await chmod(target, 0o644)
    await symlink(target, diagnosticsLogPath())
    reportPluginError("must not follow symlinks")
    expect(await readFile(target, "utf8")).toBe("preserve")
    expect((await stat(target)).mode & 0o777).toBe(0o644)
  })
})

test("oversized and multiline errors produce one bounded physical record", async () => {
  await withStatePath(async () => {
    reportPluginError("first line\nsecond line", new Error("detail\r\n" + "x".repeat(2 * 1024 * 1024)))
    const contents = await readFile(diagnosticsLogPath(), "utf8")
    expect(contents.trimEnd().split("\n")).toHaveLength(1)
    expect(Buffer.byteLength(contents)).toBeLessThanOrEqual(64 * 1024)
    expect(contents).toContain("first line")
  })
})

test("an unreadable error object still leaves an event record", async () => {
  await withStatePath(async () => {
    const error = Object.defineProperty({}, "message", { get() { throw new Error("unreadable property") } })
    expect(() => reportPluginError("event survives formatting failure", error)).not.toThrow()
    expect(await readFile(diagnosticsLogPath(), "utf8")).toContain("event survives formatting failure")
  })
})
