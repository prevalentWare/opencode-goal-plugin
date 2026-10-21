import { readFile } from "node:fs/promises"

/**
 * Reading the shared goal state file.
 *
 * The state file is replaced by an atomic write: a temp file is written and
 * then renamed over the target. On Windows that rename is not atomic, so a
 * concurrent reader can find the file momentarily missing, and a scanner or a
 * second process can hold it open for a moment. Both failures are transient -
 * the state is unchanged and the read can simply be repeated - but without a
 * retry they fail the read, and with it the goal update that needed the state
 * is lost.
 *
 * The reader is injectable so the transient failures can be reproduced.
 */

export type StateReadOps = {
  platform: NodeJS.Platform
  readFile: (path: string) => Promise<string>
  sleep: (ms: number) => Promise<void>
}

/** How many times a transient read failure is retried. */
export const READ_ATTEMPTS = 5

/** How long a caller waits between read attempts. */
export const READ_RETRY_DELAY_MS = 10

/**
 * How many times a momentarily missing file is retried, and how long the
 * caller waits between those attempts.
 *
 * A file that is genuinely missing is a normal state for a fresh install, so
 * the retries have to be short: a long wait here would delay the first write
 * far enough to reorder the events around it. The window in which another
 * instance's rename leaves the file missing is far shorter than this.
 */
export const MISSING_READ_ATTEMPTS = 3
export const MISSING_READ_RETRY_DELAY_MS = 2

export const defaultStateReadOps: StateReadOps = {
  platform: process.platform,
  readFile: (path) => readFile(path, "utf8"),
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
}

/**
 * Errors that mean "the file was not readable for a moment" rather than
 * "the file is gone" or "the read is broken".
 */
export function isTransientReadError(error: unknown, platform: NodeJS.Platform): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (code === "ENOENT") return true
  if (platform !== "win32") return false
  return code === "EPERM" || code === "EACCES" || code === "EBUSY"
}

/**
 * Read the state file, retrying a transient failure.
 *
 * A file that genuinely does not exist is retried a few times as well: the
 * difference only shows up after the retries, and a missing file is a normal
 * state for a fresh install, so the delay it costs is bounded.
 */
export async function readStateFile(file: string, ops: StateReadOps = defaultStateReadOps): Promise<string> {
  let missingAttempts = 0
  for (let attempt = 1; ; attempt++) {
    try {
      return await ops.readFile(file)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (code === "ENOENT") {
        missingAttempts += 1
        if (missingAttempts >= MISSING_READ_ATTEMPTS) throw error
        await ops.sleep(MISSING_READ_RETRY_DELAY_MS)
        continue
      }
      if (attempt >= READ_ATTEMPTS || !isTransientReadError(error, ops.platform)) throw error
      await ops.sleep(READ_RETRY_DELAY_MS)
    }
  }
}
