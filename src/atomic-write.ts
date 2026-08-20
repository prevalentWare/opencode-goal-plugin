import { randomUUID } from "node:crypto"
import { chmod, open, rename, unlink } from "node:fs/promises"
import { dirname } from "node:path"

/**
 * Minimal file-handle surface required for the atomic write sequence. Kept
 * intentionally small so tests can inject recording or failing implementations
 * without touching the real filesystem.
 */
export type FileHandleOps = {
  write(data: string): Promise<void>
  sync(): Promise<void>
  close(): Promise<void>
}

/**
 * Handle surface required from a directory opener. `syncDirectory` opens the
 * parent directory read-only for one purpose: fsync'ing it so the rename of a
 * state file into place is durable on filesystems that support that operation.
 */
export type DirHandleOps = {
  sync(): Promise<void>
  close(): Promise<void>
}

/**
 * Injectable directory opener for `syncDirectory`. The production
 * implementation opens the directory with flag `"r"`; tests inject a recording
 * opener to prove open(dir, "r") -> sync -> close without touching the real
 * filesystem.
 */
export type DirOpenOps = {
  open(dir: string, flags: string | number): Promise<DirHandleOps>
}

/**
 * Filesystem operations used by `atomicWriteFile`. Tests inject their own
 * implementations to assert call ordering and failure handling.
 */
export type AtomicWriteOps = {
  platform: NodeJS.Platform
  open(path: string, flags: string | number, mode: number): Promise<FileHandleOps>
  rename(from: string, to: string): Promise<void>
  chmod(path: string, mode: number): Promise<void>
  unlink(path: string): Promise<void>
  /**
   * Platform-aware parent-directory sync. Implementations should swallow errors
   * that mean "directory fsync is not supported here" (see
   * `isUnsupportedSyncDirError`) and propagate genuine durability failures
   * such as EIO / ENOSPC / ENOENT. `atomicWriteFile` applies the same
   * classification around this call, so an implementation that throws an
   * unsupported-class error still degrades gracefully; genuine errors fail
   * the write honestly.
   */
  syncDir(dir: string, platform: NodeJS.Platform): Promise<void>
  /** Delay between bounded Windows rename retries. */
  sleep(ms: number): Promise<void>
}

/**
 * Errors from a directory fsync that mean the platform or filesystem simply
 * does not support the operation. These are not durability failures: the file
 * content itself is already fsync'd before the rename, so the old-or-new
 * guarantee still holds without the directory sync.
 *
 * - `EINVAL` / `ENOTSUP` / `EOPNOTSUPP`: filesystems that reject fsync on a
 *   directory descriptor (macOS/APFS & friends report EINVAL).
 * - `EISDIR`: platforms that refuse directory opens for fsync purposes.
 * - `EPERM` / `EACCES` / `EBADF`: Windows cannot flush directory handles;
 *   `FlushFileBuffers` surfaces as ERROR_ACCESS_DENIED (EACCES) or
 *   ERROR_INVALID_HANDLE (EBADF) via libuv, and other layering reports EPERM.
 *
 * Genuine failures are NOT listed and must propagate: EIO, ENOSPC, ENOENT,
 * and anything else that is not a known "unsupported" signal.
 */
export function isUnsupportedSyncDirError(error: unknown, platform: NodeJS.Platform): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return (
    code === "EINVAL" ||
    code === "ENOTSUP" ||
    code === "EOPNOTSUPP" ||
    code === "EISDIR" ||
    (platform === "win32" && (code === "EPERM" || code === "EACCES" || code === "EBADF"))
  )
}

/**
 * Errors that can transiently fail a same-directory rename, most commonly on
 * Windows when the target file is briefly locked by another process (antivirus
 * scanners, an OpenCode session holding the state file open). These are worth a
 * small bounded retry before giving up. Anything else (EIO, ENOENT, ENOSPC...)
 * is a genuine failure and must not be retried.
 */
export function isTransientRenameError(error: unknown, platform: NodeJS.Platform): boolean {
  if (platform !== "win32") return false
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === "EPERM" || code === "EACCES" || code === "EBUSY"
}

async function bestEffort(action: () => void | Promise<void>): Promise<void> {
  try {
    await action()
  } catch {
    // Cleanup and permission hardening must not mask the primary operation.
  }
}

/** Production wait between rename retries: short, bounded backoff. */
export const defaultSleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Production directory opener: opens the directory read-only. */
export const defaultDirOpenOps: DirOpenOps = {
  async open(dir, flags) {
    const handle = await open(dir, flags)
    return {
      sync: () => handle.sync(),
      close: () => handle.close(),
    }
  },
}

/**
 * fsync the parent directory so the rename itself is durable where the
 * platform supports that operation (POSIX with a journaling filesystem).
 * Opening a directory and fsync'ing it is unsupported on Windows and on some
 * filesystems; those errors are classified and swallowed. Genuine failures
 * (EIO, ENOSPC, ENOENT, ...) propagate: the durability of the rename could not
 * be established, and callers must hear about it.
 *
 * Note on macOS/APFS: `fsync` here is the ordinary POSIX fsync, not
 * `F_FULLFSYNC` (which Node.js does not expose). It improves crash
 * consistency (process and OS crashes) but is not an absolute guarantee under
 * sudden power loss. File *content* durability is handled separately by
 * fsync'ing the temp file before the rename; this helper only covers the
 * durability of the rename itself.
 */
export async function syncDirectory(
  dir: string,
  ops: DirOpenOps = defaultDirOpenOps,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  let fsHandle: DirHandleOps | null = null
  try {
    const handle = await ops.open(dir, "r")
    fsHandle = handle
    await handle.sync()
  } catch (error) {
    if (!isUnsupportedSyncDirError(error, platform)) throw error
    // Directory fsync unsupported on this platform/filesystem: the write still
    // succeeds. After a crash the state file is the old or the new valid
    // version (the temp file was fully flushed before the rename), never a
    // torn one — the only thing lost by skipping this step is the durability
    // of the rename itself.
  } finally {
    const cleanupHandle = fsHandle
    if (cleanupHandle) await bestEffort(() => cleanupHandle.close())
  }
}

/** Production implementation backed by node:fs/promises. */
export const defaultAtomicWriteOps: AtomicWriteOps = {
  platform: process.platform,
  async open(path, flags, mode) {
    const handle = await open(path, flags, mode)
    return {
      write: (data) => handle.writeFile(data),
      sync: () => handle.sync(),
      close: () => handle.close(),
    }
  },
  rename,
  chmod,
  unlink,
  syncDir: (dir, platform) => syncDirectory(dir, defaultDirOpenOps, platform),
  sleep: defaultSleep,
}

/** Total rename attempts for transient Windows replacement errors. */
export const RENAME_ATTEMPTS = 3

/** Base backoff between rename retries (multiplied by the attempt number). */
export const RENAME_RETRY_DELAY_MS = 20

async function renameWithRetry(ops: AtomicWriteOps, from: string, to: string): Promise<void> {
  let attempt = 0
  for (;;) {
    try {
      await ops.rename(from, to)
      return
    } catch (error) {
      attempt += 1
      // A non-transient error fails immediately; transient errors get a small,
      // bounded number of attempts (renaming over a briefly-locked target).
      if (!isTransientRenameError(error, ops.platform) || attempt >= RENAME_ATTEMPTS) throw error
      const delay = RENAME_RETRY_DELAY_MS * attempt
      await ops.sleep(delay)
    }
  }
}

/**
 * Durably write `data` to `file` through a same-directory temp file so the
 * final path is only ever replaced atomically:
 *
 *   open(tmp, "wx", 0o600) -> write -> sync -> close -> rename(tmp, file)
 *     -> chmod(file, 0o600) -> syncDir(dirname(file))
 *
 * The temp name is a random UUID and the temp file is opened with the
 * exclusive `"wx"` flag, so concurrent writers can never collide on the same
 * temp path and a stale temp file can never be overwritten.
 *
 * The temp file is fsync'd before the rename, so the final path never exposes
 * an empty or partially-flushed file after a crash: the state file is always
 * the old or the new valid version. Ordinary fsync improves crash consistency
 * (process and OS crashes); on macOS/APFS it is not a substitute for
 * `F_FULLFSYNC`, which Node.js cannot issue, so sudden power loss has no
 * absolute durability guarantee there.
 *
 * On POSIX the parent directory is fsync'd after the rename so the rename
 * itself is durable too. Failures propagate unless the platform reports that
 * directory fsync is unsupported; when unsupported (Windows, some
 * filesystems), a crash may leave the old or the new file, but never a torn
 * one.
 *
 * Rename is retried a bounded number of times on transient Windows
 * replacement errors (`EPERM` / `EACCES` / `EBUSY`) because another process
 * may briefly hold the target state file open.
 *
 * If any step before the rename eventually fails, the temp file is unlinked
 * best-effort. The original error is preserved even when close/unlink cleanup
 * also fails. Once the rename has succeeded, the final file is never unlinked:
 * a later chmod or directory-sync failure is either tolerated (unsupported
 * directory fsync) or propagated honestly (EIO / ENOSPC / ...) with the new
 * content already in place.
 */
export async function atomicWriteFile(
  file: string,
  data: string,
  ops: AtomicWriteOps = defaultAtomicWriteOps,
): Promise<void> {
  const tmp = `${file}.${randomUUID()}.tmp`
  let handle: FileHandleOps | null = null
  let created = false
  let renamed = false
  try {
    // "wx" = create exclusively: fail with EEXIST if the temp path already
    // exists, so an accidental collision can never clobber another writer's
    // file. The UUID name makes collisions effectively impossible anyway.
    handle = await ops.open(tmp, "wx", 0o600)
    created = true
    await handle.write(data)
    await handle.sync()
    await handle.close()
    handle = null
    await renameWithRetry(ops, tmp, file)
    renamed = true
    // The temp file was created 0o600; chmod guards against umask and any
    // permissions drift between open and rename. Best-effort by design.
    await bestEffort(() => ops.chmod(file, 0o600))
    // Directory sync: only known-unsupported errors are tolerated.
    // Genuine durability failures (EIO, ENOSPC, ENOENT, ...) propagate — the
    // rename already happened, so the new content is in place, and the caller
    // deserves an honest report instead of a silent swallow.
    try {
      await ops.syncDir(dirname(file), ops.platform)
    } catch (error) {
      if (!isUnsupportedSyncDirError(error, ops.platform)) throw error
    }
  } catch (error) {
    // Best-effort cleanup that must never mask the primary error. Only the
    // temp path is ever removed; after a successful rename the final file is
    // left alone (a crash there may leave old or new content, never torn).
    const cleanupHandle = handle
    if (cleanupHandle) await bestEffort(() => cleanupHandle.close())
    if (created && !renamed) await bestEffort(() => ops.unlink(tmp))
    throw error
  }
}
