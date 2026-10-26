import { spyOn } from "bun:test"
import * as fs from "node:fs/promises"

/** Hold one captured state snapshot while real mutations create a newer attempt. */
export function holdNextStateRead(file: string, skipReads = 0) {
  const captured = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  const read = fs.readFile
  let armed = true
  // Forward all native overloads without changing their arguments or result type.
  const intercepted = new Proxy(read, {
    apply(target, receiver, args) {
      const result: ReturnType<typeof read> = Reflect.apply(target, receiver, args)
      return result.then(async (contents) => {
        if (armed && args[0] === file) {
          if (skipReads > 0) {
            skipReads--
            return contents
          }
          armed = false
          captured.resolve()
          await released.promise
        }
        return contents
      })
    },
  })
  const spy = spyOn(fs, "readFile").mockImplementation(intercepted)
  return {
    captured: captured.promise,
    release: released.resolve,
    restore() {
      released.resolve()
      spy.mockRestore()
    },
  }
}
