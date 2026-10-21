import { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs"
import { dirname, join } from "node:path"
import { statePath } from "./state-path"

/**
 * Diagnostics log for the plugin.
 *
 * OpenCode's V2 plugin API has no logger: the context exposes the app
 * metadata, the location, and the domain APIs, but nothing that writes to the
 * server log. Plugin `console.error` output does not reach the OpenCode log
 * either, so a failure inside the plugin is invisible to anything that only
 * watches the host log.
 *
 * The plugin therefore keeps its own diagnostics log next to the goal state
 * file, where a monitor can read it. The host log stays the primary source;
 * this file covers the failures the host log cannot show.
 */

/** Rotate once the log passes this size so a failure loop cannot fill the disk. */
const MAX_LOG_BYTES = 1024 * 1024

/**
 * The diagnostics log of a state file.
 *
 * A failure has to be reported next to the state file it is about. The lock
 * guards one specific state file, and a test or a tool can work on a state
 * file of its own, so reporting every failure to the log of the global state
 * file mixes unrelated failures into one place - and puts the failures of a
 * test run into the log that a monitor watches for the running plugin.
 */
export function diagnosticsLogPath(stateFile?: string) {
  return join(dirname(stateFile ?? statePath()), "goal-plugin.log")
}

function rotateIfNeeded(path: string) {
  let size: number
  try {
    size = statSync(path).size
  } catch {
    return
  }
  if (size < MAX_LOG_BYTES) return
  const previous = `${path}.1`
  try {
    unlinkSync(previous)
  } catch {
    // A missing previous file is the normal case.
  }
  try {
    renameSync(path, previous)
  } catch {
    // If the rotation fails the log keeps growing to the next write, which
    // is still bounded by the check below.
  }
}

/**
 * Effect keeps the cause of a failed fiber behind this symbol. The public
 * `cause` getter is not usable for that, so the symbol is read directly.
 */
const EFFECT_CAUSE: symbol = Symbol.for("effect/Runtime/FiberFailure/Cause")

/**
 * Describe an Effect cause: a failure carries the error, a defect carries the
 * thrown value, and a composite cause carries a set of both.
 */
function describeEffectCause(cause: unknown, depth: number): string {
  if (cause == null || typeof cause !== "object") return String(cause)
  const record = cause as Record<string, unknown>
  if (record._tag === "Fail") return describeError(record.error, depth + 1)
  if (record._tag === "Die") return describeError(record.defect, depth + 1)
  if (record._tag === "Interrupt") return "interrupted"
  const failures = record.failures
  if (failures && typeof failures === "object") {
    const parts = [...(failures as Iterable<unknown>)]
      .map((failure) => describeEffectCause(failure, depth + 1))
      .filter(Boolean)
    if (parts.length) return parts.join(" ; ")
  }
  return describeError(cause, depth + 1)
}

/**
 * Describe an error and the causes behind it.
 *
 * The plugin's state layer reports failures through Effect, so the error that
 * reaches a caller is often a FiberFailure whose message is just "An error
 * has occurred". The real reason - a failed rename, a full disk, a state file
 * that changed underneath - only lives in the cause chain, so the chain has to
 * be unwrapped or the diagnostics say nothing useful.
 */
export function describeError(error: unknown, depth = 0): string {
  if (error == null) return String(error)
  if (typeof error === "string") return error
  if (typeof error !== "object") return String(error)
  if (depth > 6) return "..."
  const record = error as Record<string, unknown>
  const tag =
    typeof record._tag === "string"
      ? record._tag
      : typeof record.name === "string"
        ? record.name
        : typeof record.constructor === "string"
          ? record.constructor
          : "Error"
  const message = typeof record.message === "string" ? record.message : ""
  const head = message && message !== tag ? `${tag}: ${message}` : tag
  const effectCause = (record as Record<PropertyKey, unknown>)[EFFECT_CAUSE]
  if (effectCause) return `${head} <- ${describeEffectCause(effectCause, depth)}`
  const cause = record.cause
  if (cause == null) return head
  if (typeof cause === "string") return `${head} <- ${cause}`
  if (typeof cause === "object") {
    // Effect's internal Cause carries a readable rendering.
    const pretty = (cause as Record<string, unknown>).pretty
    if (typeof pretty === "string" && pretty.trim()) {
      return `${head} <- ${pretty.split("\n").map((line) => line.trim()).filter(Boolean).join(" | ")}`
    }
  }
  return `${head} <- ${describeError(cause, depth + 1)}`
}

/**
 * Append one diagnostics line. Never throws: a failing diagnostics writer
 * must not turn a recoverable plugin error into a crash.
 *
 * The state file the failure is about decides where the line is written, so
 * that the log next to a state file only holds the failures of that state
 * file.
 */
export function reportPluginError(message: string, error?: unknown, stateFile?: string) {
  try {
    const path = diagnosticsLogPath(stateFile)
    mkdirSync(dirname(path), { recursive: true })
    rotateIfNeeded(path)
    const detail = error === undefined ? "" : ` | ${describeError(error)}`
    appendFileSync(path, `${new Date().toISOString()} | error | ${message}${detail}\n`)
  } catch {
    // Diagnostics must never break plugin control flow.
  }
}
