import { appendFile, stat, writeFile } from "node:fs/promises"
import { withStateFileLockForTest } from "../../src/state"

const [name, enteredPath, releasePath, eventLogPath] = process.argv.slice(2)

if (!name || !enteredPath || !releasePath || !eventLogPath) {
  throw new Error("usage: state-lock-contender <name> <entered-path> <release-path> <event-log-path>")
}

async function exists(path: string) {
  return stat(path).then(
    () => true,
    () => false,
  )
}

await withStateFileLockForTest(async () => {
  await appendFile(eventLogPath, `enter:${name}\n`, "utf8")
  await writeFile(enteredPath, name, "utf8")
  while (!(await exists(releasePath))) await Bun.sleep(5)
  await appendFile(eventLogPath, `exit:${name}\n`, "utf8")
})
