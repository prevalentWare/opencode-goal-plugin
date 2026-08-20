import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  RENAME_ATTEMPTS,
  RENAME_RETRY_DELAY_MS,
  atomicWriteFile,
  defaultAtomicWriteOps,
  defaultDirOpenOps,
  defaultSleep,
  syncDirectory,
} from "../src/atomic-write"
import type { AtomicWriteOps, DirHandleOps, DirOpenOps, FileHandleOps } from "../src/atomic-write"

let dir = ""
let file = ""

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "opencode-goal-atomic-"))
  file = join(dir, "goals.json")
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/**
 * Windows cannot express POSIX mode bits: Node reports writable files as
 * 0o666 (0o444 when the read-only attribute is set). Keep the exact 0600
 * assertion on POSIX and assert "not read-only" on Windows.
 */
function expectOwnerOnlyMode(mode: number) {
  if (process.platform === "win32") {
    expect(mode & 0o222).not.toBe(0)
  } else {
    expect(mode).toBe(0o600)
  }
}

function errno(code: string, message: string) {
  const error = new Error(message) as NodeJS.ErrnoException
  error.code = code
  return error
}

type Event = { op: string; args: unknown[] }

/**
 * Wraps the production ops with a recorder, delegating to the real filesystem
 * unless a specific op/handle method is overridden. Every invocation (including
 * overridden ones) is recorded in order.
 */
function makeRecordingOps(overrides: { ops?: Partial<AtomicWriteOps>; handle?: Partial<FileHandleOps> } = {}) {
  const events: Event[] = []
  const record = (op: string, args: unknown[]) => events.push({ op, args })

  const ops: AtomicWriteOps = {
    platform: overrides.ops?.platform ?? process.platform,
    async open(path, flags, mode) {
      record("open", [path, flags, mode])
      if (overrides.ops?.open) return overrides.ops.open(path, flags, mode)
      const inner = await defaultAtomicWriteOps.open(path, flags, mode)
      return {
        write: (data) => {
          record("write", [data])
          return overrides.handle?.write ? overrides.handle.write(data) : inner.write(data)
        },
        sync: () => {
          record("sync", [])
          return overrides.handle?.sync ? overrides.handle.sync() : inner.sync()
        },
        close: () => {
          record("close", [])
          return overrides.handle?.close ? overrides.handle.close() : inner.close()
        },
      }
    },
    rename(from, to) {
      record("rename", [from, to])
      return overrides.ops?.rename ? overrides.ops.rename(from, to) : defaultAtomicWriteOps.rename(from, to)
    },
    chmod(path, mode) {
      record("chmod", [path, mode])
      return overrides.ops?.chmod ? overrides.ops.chmod(path, mode) : defaultAtomicWriteOps.chmod(path, mode)
    },
    unlink(path) {
      record("unlink", [path])
      return overrides.ops?.unlink ? overrides.ops.unlink(path) : defaultAtomicWriteOps.unlink(path)
    },
    syncDir(dir, platform) {
      record("syncDir", [dir, platform])
      return overrides.ops?.syncDir
        ? overrides.ops.syncDir(dir, platform)
        : defaultAtomicWriteOps.syncDir(dir, platform)
    },
    sleep(ms) {
      record("sleep", [ms])
      return overrides.ops?.sleep ? overrides.ops.sleep(ms) : Promise.resolve()
    },
  }

  const opsCalled = () => events.map((event) => event.op)
  const argsFor = (op: string) => {
    const event = events.find((candidate) => candidate.op === op)
    if (!event) throw new Error(`expected an ${op} call, got ${opsCalled().join(", ")}`)
    return event.args
  }
  const allArgsFor = (op: string) => events.filter((candidate) => candidate.op === op).map((candidate) => candidate.args)
  return { ops, events, opsCalled, argsFor, allArgsFor }
}

async function leftoverTmpFiles() {
  const entries = await readdir(dir)
  return entries.filter((name) => name.endsWith(".tmp"))
}

const DATA = '{"version":1}\n'

test("writes through the full atomic sequence in order and persists content and mode", async () => {
  const { ops, opsCalled, argsFor } = makeRecordingOps()

  await atomicWriteFile(file, DATA, ops)

  expect(opsCalled()).toEqual(["open", "write", "sync", "close", "rename", "chmod", "syncDir"])

  // The temp file lives next to the final file (same directory) so the rename
  // is atomic, its name is a random UUID, and it is opened exclusively with
  // owner-only mode.
  const openArgs = argsFor("open")
  const tmpPath = openArgs[0] as string
  expect(tmpPath.startsWith(`${file}.`)).toBe(true)
  expect(tmpPath.endsWith(".tmp")).toBe(true)
  const tmpName = tmpPath.slice(file.length + 1, -".tmp".length)
  expect(tmpName).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  expect(openArgs[1]).toBe("wx")
  expect(openArgs[2]).toBe(0o600)

  // rename moves the temp file onto the final path; chmod and the parent
  // directory sync both run after the rename.
  expect(argsFor("rename")).toEqual([tmpPath, file])
  expect(argsFor("chmod")[1]).toBe(0o600)
  expect(argsFor("syncDir")[0]).toBe(dir)

  expect(await readFile(file, "utf8")).toBe(DATA)
  expectOwnerOnlyMode((await stat(file)).mode & 0o777)
  expect(await leftoverTmpFiles()).toEqual([])
})

test("uses a fresh, exclusive temp path for every write", async () => {
  const first = makeRecordingOps()
  await atomicWriteFile(file, DATA, first.ops)
  const second = makeRecordingOps()
  await atomicWriteFile(file, DATA, second.ops)

  const firstTmp = first.argsFor("open")[0] as string
  const secondTmp = second.argsFor("open")[0] as string
  expect(firstTmp).not.toBe(secondTmp)
  expect(first.argsFor("open")[1]).toBe("wx")
  expect(second.argsFor("open")[1]).toBe("wx")
  expect(await readFile(file, "utf8")).toBe(DATA)
})

test("unlinks the temp file when sync fails and preserves the sync error", async () => {
  await writeFile(file, "old state", "utf8")
  const { ops, opsCalled } = makeRecordingOps({
    handle: {
      sync: async () => {
        throw new Error("sync boom")
      },
    },
  })

  await expect(atomicWriteFile(file, "new state", ops)).rejects.toThrow("sync boom")

  // The handle is still best-effort closed before the temp file is unlinked.
  expect(opsCalled()).toEqual(["open", "write", "sync", "close", "unlink"])
  expect(await readFile(file, "utf8")).toBe("old state")
  expect(await leftoverTmpFiles()).toEqual([])
})

test("preserves the primary error when close and unlink cleanup throw synchronously", async () => {
  await writeFile(file, "old state", "utf8")
  const primary = new Error("sync boom")
  const { ops, opsCalled } = makeRecordingOps({
    handle: {
      sync: async () => {
        throw primary
      },
      close: () => {
        throw new Error("close boom")
      },
    },
    ops: {
      unlink: () => {
        throw new Error("unlink boom")
      },
    },
  })

  await expect(atomicWriteFile(file, "new state", ops)).rejects.toThrow("sync boom")
  expect(opsCalled()).toEqual(["open", "write", "sync", "close", "unlink"])
  expect(await readFile(file, "utf8")).toBe("old state")
})

test("unlinks the temp file when rename fails and leaves the final file untouched", async () => {
  await writeFile(file, "old state", "utf8")
  const { ops, opsCalled } = makeRecordingOps({
    ops: {
      rename: async () => {
        throw errno("EIO", "rename boom")
      },
    },
  })

  await expect(atomicWriteFile(file, "new state", ops)).rejects.toThrow("rename boom")

  expect(opsCalled()).toEqual(["open", "write", "sync", "close", "rename", "unlink"])
  expect(await readFile(file, "utf8")).toBe("old state")
  expect(await leftoverTmpFiles()).toEqual([])
})

test("an open failure never unlinks or touches the final file", async () => {
  await writeFile(file, "old state", "utf8")
  const { ops, opsCalled } = makeRecordingOps({
    ops: {
      open: async () => {
        throw new Error("open boom")
      },
    },
  })

  await expect(atomicWriteFile(file, "new state", ops)).rejects.toThrow("open boom")

  // No temp file was ever created, so there is nothing to clean up.
  expect(opsCalled()).toEqual(["open"])
  expect(await readFile(file, "utf8")).toBe("old state")
  expect(await leftoverTmpFiles()).toEqual([])
})

test("unlinks the temp file when the write fails", async () => {
  await writeFile(file, "old state", "utf8")
  const { ops, opsCalled } = makeRecordingOps({
    handle: {
      write: async () => {
        throw new Error("write boom")
      },
    },
  })

  await expect(atomicWriteFile(file, "new state", ops)).rejects.toThrow("write boom")

  expect(opsCalled()).toEqual(["open", "write", "close", "unlink"])
  expect(await readFile(file, "utf8")).toBe("old state")
  expect(await leftoverTmpFiles()).toEqual([])
})

test("a close failure before rename fails the write and cleans up the temp file", async () => {
  await writeFile(file, "old state", "utf8")
  const { ops, opsCalled } = makeRecordingOps({
    handle: {
      close: async () => {
        throw new Error("close boom")
      },
    },
  })

  await expect(atomicWriteFile(file, "new state", ops)).rejects.toThrow("close boom")

  // The failing success-path close plus the best-effort cleanup close both run;
  // the temp file is still removed and the close error stays the primary one.
  expect(opsCalled()).toEqual(["open", "write", "sync", "close", "close", "unlink"])
  expect(await readFile(file, "utf8")).toBe("old state")
  expect(await leftoverTmpFiles()).toEqual([])
})

test("an unsupported directory fsync is skipped without failing the write", async () => {
  const { ops, opsCalled } = makeRecordingOps({
    ops: {
      syncDir: async () => {
        throw errno("EINVAL", "directory fsync not supported")
      },
    },
  })

  // Windows / filesystems without directory fsync must degrade gracefully.
  await atomicWriteFile(file, DATA, ops)

  expect(opsCalled()).toEqual(["open", "write", "sync", "close", "rename", "chmod", "syncDir"])
  expect(await readFile(file, "utf8")).toBe(DATA)
  expect(await leftoverTmpFiles()).toEqual([])
})

test("a genuine directory-sync failure fails the write but keeps the renamed file", async () => {
  const { ops, opsCalled } = makeRecordingOps({
    ops: {
      syncDir: async () => {
        throw errno("EIO", "disk error while flushing directory")
      },
    },
  })

  await expect(atomicWriteFile(file, DATA, ops)).rejects.toThrow("disk error while flushing directory")

  // The rename had already succeeded, so the final file holds the new content;
  // durability of the rename could not be established and that is reported
  // honestly. The final file is never unlinked.
  expect(opsCalled()).toEqual(["open", "write", "sync", "close", "rename", "chmod", "syncDir"])
  expect(await readFile(file, "utf8")).toBe(DATA)
  expect(await leftoverTmpFiles()).toEqual([])
})

test("a synchronous chmod throw after rename does not fail the write and never unlinks", async () => {
  const { ops, opsCalled } = makeRecordingOps({
    ops: {
      chmod: () => {
        throw new Error("chmod boom")
      },
    },
  })

  await atomicWriteFile(file, DATA, ops)

  expect(opsCalled()).toEqual(["open", "write", "sync", "close", "rename", "chmod", "syncDir"])
  expect(await readFile(file, "utf8")).toBe(DATA)
  expect(await leftoverTmpFiles()).toEqual([])
})

test("the default directory sync completes for an existing directory", async () => {
  await expect(defaultAtomicWriteOps.syncDir(dir, process.platform)).resolves.toBeUndefined()
})

test("the default directory sync propagates genuine errors such as ENOENT", async () => {
  // A missing directory is a real problem, not "unsupported": it must surface.
  await expect(defaultAtomicWriteOps.syncDir(join(dir, "does-not-exist"), process.platform)).rejects.toMatchObject({
    code: "ENOENT",
  })
})

test("the real directory sync helper opens the directory read-only, syncs, then closes", async () => {
  const events: string[] = []
  const handle: DirHandleOps = {
    sync: async () => {
      events.push("sync")
    },
    close: async () => {
      events.push("close")
    },
  }
  const dirOps: DirOpenOps = {
    open: async (path, flags) => {
      events.push(`open:${path}:${String(flags)}`)
      return handle
    },
  }

  await syncDirectory(dir, dirOps)

  expect(events).toEqual([`open:${dir}:r`, "sync", "close"])
})

test("the real directory sync helper swallows unsupported fsync errors and propagates genuine ones", async () => {
  for (const code of ["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EISDIR"] as const) {
    const unsupported: DirOpenOps = {
      open: () => {
        throw errno(code, `${code}: fsync not supported on directories here`)
      },
    }
    await expect(syncDirectory(dir, unsupported, "darwin")).resolves.toBeUndefined()
    await expect(syncDirectory(dir, unsupported, "win32")).resolves.toBeUndefined()
  }

  const genuine: DirOpenOps = {
    open: async () => {
      throw errno("EIO", "disk gone")
    },
  }
  await expect(syncDirectory(dir, genuine)).rejects.toThrow("disk gone")
})

test("the directory sync helper ignores a synchronous close cleanup failure", async () => {
  const dirOps: DirOpenOps = {
    open: async () => ({
      sync: async () => undefined,
      close: () => {
        throw new Error("close boom")
      },
    }),
  }

  await expect(syncDirectory(dir, dirOps)).resolves.toBeUndefined()
})

for (const code of ["EPERM", "EACCES", "EBADF"] as const) {
  test(`directory sync propagates ${code} on POSIX and tolerates it on Windows`, async () => {
    const unsupportedOnWindows: DirOpenOps = {
      open: () => {
        throw errno(code, `${code}: directory handle cannot be flushed`)
      },
    }

    await expect(syncDirectory(dir, unsupportedOnWindows, "darwin")).rejects.toThrow(code)
    await expect(syncDirectory(dir, unsupportedOnWindows, "win32")).resolves.toBeUndefined()

    const posix = makeRecordingOps({
      ops: {
        platform: "darwin",
        syncDir: () => {
          throw errno(code, `${code}: directory sync denied`)
        },
      },
    })
    await expect(atomicWriteFile(file, DATA, posix.ops)).rejects.toThrow(code)

    const windows = makeRecordingOps({
      ops: {
        platform: "win32",
        syncDir: () => {
          throw errno(code, `${code}: directory sync unsupported`)
        },
      },
    })
    await expect(atomicWriteFile(file, DATA, windows.ops)).resolves.toBeUndefined()
    expect(await readFile(file, "utf8")).toBe(DATA)
    expect(await leftoverTmpFiles()).toEqual([])
  })
}

test("the default rename backoff waits asynchronously", async () => {
  let settled = false
  const sleeping = defaultSleep(10).then(() => {
    settled = true
  })

  await Promise.resolve()
  expect(settled).toBe(false)
  await sleeping
  expect(settled).toBe(true)
})

test("the real directory open passes the read-only flag through to node:fs", async () => {
  const events: string[] = []
  const dirOps: DirOpenOps = {
    async open(path, flags) {
      // Wrap the production opener so the real open(dir, "r") occurs.
      const handle = await defaultDirOpenOps.open(path, flags)
      events.push(`open:${path}:${String(flags)}`)
      return {
        sync: () => {
          events.push("sync")
          return handle.sync()
        },
        close: () => {
          events.push("close")
          return handle.close()
        },
      }
    },
  }

  await syncDirectory(dir, dirOps)

  expect(events).toEqual([`open:${dir}:r`, "sync", "close"])
})

for (const code of ["EPERM", "EACCES", "EBUSY"] as const) {
  test(`rename retries a transient Windows ${code} failure and succeeds`, async () => {
    let failures = 1
    const { ops, opsCalled, allArgsFor, argsFor } = makeRecordingOps({
      ops: {
        platform: "win32",
        rename: async (from, to) => {
          if (failures > 0) {
            failures -= 1
            throw errno(code, `${code}: target temporarily locked`)
          }
          return defaultAtomicWriteOps.rename(from, to)
        },
      },
    })

    await atomicWriteFile(file, DATA, ops)

    expect(opsCalled()).toEqual([
      "open",
      "write",
      "sync",
      "close",
      "rename",
      "sleep",
      "rename",
      "chmod",
      "syncDir",
    ])
    // One short backoff between the two rename attempts.
    expect(argsFor("sleep")[0]).toBe(RENAME_RETRY_DELAY_MS)
    expect(allArgsFor("rename")).toHaveLength(2)
    expect(await readFile(file, "utf8")).toBe(DATA)
    expect(await leftoverTmpFiles()).toEqual([])
  })

  test(`rename does not retry ${code} on POSIX`, async () => {
    await writeFile(file, "old state", "utf8")
    const { ops, opsCalled, allArgsFor } = makeRecordingOps({
      ops: {
        platform: "darwin",
        rename: () => {
          throw errno(code, `${code}: rename denied`)
        },
      },
    })

    await expect(atomicWriteFile(file, "new state", ops)).rejects.toThrow(`${code}: rename denied`)

    expect(allArgsFor("rename")).toHaveLength(1)
    expect(opsCalled()).toEqual(["open", "write", "sync", "close", "rename", "unlink"])
    expect(await readFile(file, "utf8")).toBe("old state")
  })
}

test("rename retry exhaustion fails, preserves the old file, and cleans the temp file", async () => {
  await writeFile(file, "old state", "utf8")
  const { ops, opsCalled, allArgsFor } = makeRecordingOps({
    ops: {
      platform: "win32",
      rename: async () => {
        throw errno("EPERM", "EPERM: target locked")
      },
    },
  })

  await expect(atomicWriteFile(file, "new state", ops)).rejects.toThrow("EPERM: target locked")

  expect(allArgsFor("rename")).toHaveLength(RENAME_ATTEMPTS)
  expect(opsCalled()).toEqual([
    "open",
    "write",
    "sync",
    "close",
    "rename",
    "sleep",
    "rename",
    "sleep",
    "rename",
    "unlink",
  ])
  // Backoff grows per attempt: 20ms then 40ms.
  expect(allArgsFor("sleep").map((args) => args[0])).toEqual([
    RENAME_RETRY_DELAY_MS,
    RENAME_RETRY_DELAY_MS * 2,
  ])
  // The old file survived and the temp file was cleaned up.
  expect(await readFile(file, "utf8")).toBe("old state")
  expect(await leftoverTmpFiles()).toEqual([])
})

test("a non-transient rename error is never retried", async () => {
  await writeFile(file, "old state", "utf8")
  const { ops, opsCalled, allArgsFor } = makeRecordingOps({
    ops: {
      rename: async () => {
        throw errno("EIO", "EIO: disk error")
      },
    },
  })

  await expect(atomicWriteFile(file, "new state", ops)).rejects.toThrow("EIO: disk error")

  expect(allArgsFor("rename")).toHaveLength(1)
  expect(opsCalled()).toEqual(["open", "write", "sync", "close", "rename", "unlink"])
  expect(await readFile(file, "utf8")).toBe("old state")
  expect(await leftoverTmpFiles()).toEqual([])
})
