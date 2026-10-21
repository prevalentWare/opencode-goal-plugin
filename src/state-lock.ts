import { open, stat, unlink } from "node:fs/promises"
import { reportPluginError } from "./diagnostics"

/**
 * Cross-process lock for the shared goal state file.
 *
 * Every OpenCode directory runs its own plugin instance and every instance
 * shares one goals.json. The mutation queue that serialises read-modify-write
 * is module level, so it only serialises mutations inside one process: two
 * servers (or a server and a CLI invocation) can read the same state, change
 * it, and write it back at the same time. The second writer then overwrites
 * the first writer's changes, which can drop a whole goal.
 *
 * The lock closes that window. It is deliberately best effort: when the lock
 * cannot be taken, the caller still proceeds, because a lock that can block
 * goal persistence forever is worse than the race it prevents.
 */

/** How long a lock file may exist before it is treated as abandoned. */
const LOCK_STALE_MS = 30_000

/** How long a caller waits for a contended lock before proceeding anyway. */
const LOCK_TIMEOUT_MS = 5_000

/** How long a caller waits between attempts. */
const LOCK_RETRY_MS = 20

export function stateLockPath(stateFile: string) {
  return `${stateFile}.lock`
}

/**
 * The state file a lock path belongs to.
 *
 * The lock path is the state path with a `.lock` suffix, so the state file it
 * protects can be recovered from it. A failure to take the lock is reported
 * next to that state file, not next to the global one.
 */
export function stateFileFromLockPath(lockPath: string) {
  return lockPath.endsWith(".lock") ? lockPath.slice(0, -".lock".length) : lockPath
}

export type StateLock = { release: () => Promise<void>; held: boolean }

export type StateLockOptions = {
  /** How long to wait for a contended lock before proceeding anyway. */
  timeoutMs?: number
  /** How long a lock file may exist before it is treated as abandoned. */
  staleMs?: number
}

/**
 * Take the lock for `lockPath`, or give up and report `held: false` when the
 * lock cannot be taken. The returned release function is always safe to
 * call, whether or not the lock was held.
 */
export async function acquireStateLock(lockPath: string, options: StateLockOptions = {}): Promise<StateLock> {
  const timeoutMs = options.timeoutMs ?? LOCK_TIMEOUT_MS
  const staleMs = options.staleMs ?? LOCK_STALE_MS
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const handle = await open(lockPath, "wx")
      try {
        await handle.close()
      } catch {
        // The lock file exists, which is all that matters.
      }
      return {
        held: true,
        release: async () => {
          try {
            await unlink(lockPath)
          } catch {
            // A lock that cannot be removed is broken by the stale timeout.
          }
        },
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code
      // An exclusive create reports contention in more than one way. Windows
      // reports EEXIST when the lock file is there, and a transient EPERM
      // while the file is being removed by the previous holder. Both mean
      // "try again"; anything else means the lock cannot be created here.
      const contended = code === "EEXIST" || code === "EPERM" || code === "EACCES"
      if (!contended) {
        reportPluginError(
          `Could not create the state lock at ${lockPath}`,
          error instanceof Error ? error : new Error(String(code ?? "unknown error")),
          stateFileFromLockPath(lockPath),
        )
        return { held: false, release: async () => {} }
      }
      // A lock left behind by a crashed process must not block the others.
      try {
        const stats = await stat(lockPath)
        if (Date.now() - stats.mtimeMs > staleMs) {
          await unlink(lockPath)
          continue
        }
      } catch {
        // The lock is gone: the failure was a transient one, so retry.
      }
      if (Date.now() >= deadline) {
        reportPluginError(`Gave up waiting for the state lock at ${lockPath}`, undefined, stateFileFromLockPath(lockPath))
        return { held: false, release: async () => {} }
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS))
    }
  }
}
