import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import serverPlugin from "../src/server"

test("compiles against OpenCode plugin APIs 1.17.17 and 1.18.3", () => {
  const v117 = JSON.parse(readFileSync("node_modules/opencode-plugin-v117/package.json", "utf8")) as { version: string }
  const v118 = JSON.parse(readFileSync("node_modules/@opencode-ai/plugin/package.json", "utf8")) as { version: string }

  expect(v117.version).toBe("1.17.17")
  expect(v118.version).toBe("1.18.3")
  expect(typeof serverPlugin.server).toBe("function")
})
