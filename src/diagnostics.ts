import { closeSync, constants, fchmodSync, fstatSync, mkdirSync, openSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { Cause, Runtime } from "effect-goal-state"
import { z } from "zod"
import { statePath } from "./state-path"

// Keep one active log and one archive. Unusable files or failed rotation drop
// the incoming event rather than allowing a failing logger to keep growing.
const MAX_LOG_BYTES = 1024 * 1024
const MAX_ENTRY_CHARS = 16_000
const ErrorDetails = z.object({
  _tag: z.unknown().optional(),
  name: z.unknown().optional(),
  message: z.unknown().optional(),
  cause: z.unknown().optional(),
})

export function diagnosticsLogPath(stateFile?: string) {
  return join(dirname(stateFile ?? statePath()), "goal-plugin.log")
}

function clipped(text: string) {
  return text.length > MAX_ENTRY_CHARS ? `${text.slice(0, MAX_ENTRY_CHARS)}...` : text
}

function withPrivateLog<T>(path: string, create: boolean, run: (fd: number) => T): T {
  const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK |
    (create ? constants.O_CREAT : 0)
  const fd = openSync(path, flags, 0o600)
  try {
    if (!fstatSync(fd).isFile()) throw new Error("diagnostic log destination is not a regular file")
    fchmodSync(fd, 0o600)
    return run(fd)
  } finally {
    closeSync(fd)
  }
}

function secureArchive(path: string) {
  try {
    withPrivateLog(path, false, () => {})
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return
    throw error
  }
}

function appendWithinBudget(path: string, line: string) {
  return withPrivateLog(path, true, (fd) => {
    if (fstatSync(fd).size + Buffer.byteLength(line) > MAX_LOG_BYTES) return false
    writeFileSync(fd, line)
    return true
  })
}

/** Describe ordinary causes and real Effect fibers without depending on private shapes. */
export function describeError(error: unknown, depth = 0): string {
  try {
    if (error == null || typeof error !== "object") return clipped(String(error))
    if (depth > 6) return "..."
    const record = ErrorDetails.parse(error)
    const tag = typeof record._tag === "string" ? record._tag : typeof record.name === "string" ? record.name : "Error"
    const message = typeof record.message === "string" ? clipped(record.message) : ""
    const head = message && message !== tag ? `${tag}: ${message}` : tag
    if (Runtime.isFiberFailure(error)) {
      return clipped(`${head} <- ${Cause.pretty(error[Runtime.FiberFailureCauseId])}`)
    }
    return record.cause == null ? clipped(head) : clipped(`${head} <- ${describeError(record.cause, depth + 1)}`)
  } catch {
    return "[unreadable error]"
  }
}

/** Best-effort diagnostics; failures must not change plugin control flow. */
export function reportPluginError(message: string, error?: unknown, stateFile?: string) {
  try {
    const path = diagnosticsLogPath(stateFile)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const detail = error === undefined ? "" : ` | ${describeError(error)}`
    // Bound the entire record, including caller-supplied messages. Escaping
    // controls keeps one physical line per event and the UTF-8 entry below 64 KiB.
    const line = clipped(`${new Date().toISOString()} | error | ${message}${detail}`)
      .replace(/\p{Cc}/gu, " ") + "\n"
    secureArchive(`${path}.1`)
    if (!appendWithinBudget(path, line)) {
      // The active descriptor is closed before rename, including on Windows.
      // Never delete the old archive first: a failed replacement preserves it.
      renameSync(path, `${path}.1`)
      appendWithinBudget(path, line)
    }
  } catch {
    // Permissions, rotation, or disk failures must never break the caller.
  }
}
