import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { atomicWriteFile, defaultAtomicWriteOps } from "../src/atomic-write"

if (process.env.OPENCODE_REQUIRE_WINDOWS_TEST === "1" && process.platform !== "win32") {
  throw new Error("The native Windows gate must run on Windows instead of skipping")
}

test.skipIf(process.platform !== "win32")("native Windows lock survives beyond three rename attempts", async () => {
  const root = await mkdtemp(join(tmpdir(), "goal-windows-rename-"))
  try {
    const file = join(root, "goals.json")
    const ready = join(root, "ready")
    const release = join(root, "release")
    const oldState = '{"version":1,"value":"old"}'
    const newState = '{"version":1,"value":"new"}'
    await writeFile(file, oldState)
    // ReadWrite deliberately omits FileShare.Delete, blocking replacement.
    const holder = Bun.spawn(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `
      $ErrorActionPreference = 'Stop'
      $handle = [System.IO.File]::Open($env:GOAL_LOCK_FILE,
        [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
      try {
        [System.IO.File]::WriteAllText($env:GOAL_LOCK_READY, 'ready')
        $deadline = [DateTime]::UtcNow.AddSeconds(15)
        while (!(Test-Path -LiteralPath $env:GOAL_LOCK_RELEASE) -and [DateTime]::UtcNow -lt $deadline) {
          Start-Sleep -Milliseconds 10
        }
      } finally { $handle.Dispose() }
    `], {
      env: {
        ...process.env,
        GOAL_LOCK_FILE: file,
        GOAL_LOCK_READY: ready,
        GOAL_LOCK_RELEASE: release,
      },
      stdin: "ignore", stdout: "ignore", stderr: "pipe",
    })
    const errorOutput = new Response(holder.stderr).text()
    try {
      const deadline = Date.now() + 10000
      while (!existsSync(ready)) {
        if (holder.exitCode !== null) throw new Error(await errorOutput)
        if (Date.now() >= deadline) throw new Error("Windows lock holder was not ready within 10 seconds")
        await Bun.sleep(10)
      }
      let failures = 0
      await atomicWriteFile(file, newState, {
        ...defaultAtomicWriteOps,
        async rename(from, to) {
          try {
            await defaultAtomicWriteOps.rename(from, to)
          } catch (error) {
            const code = error instanceof Error && "code" in error ? error.code : undefined
            expect(code).toMatch(/^(EPERM|EACCES|EBUSY)$/)
            failures++
            if (failures === 4) {
              expect(await readFile(file, "utf8")).toBe(oldState)
              await writeFile(release, "release")
            }
            throw error
          }
        },
      })
      expect(failures).toBeGreaterThanOrEqual(4)
      expect(await readFile(file, "utf8")).toBe(newState)
      expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([])
    } finally {
      if (holder.exitCode === null) holder.kill()
      await holder.exited
      await errorOutput
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 20000)
