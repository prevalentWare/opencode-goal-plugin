import { expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { satisfies } from "semver"

test("published tui entrypoint shares host runtime instances via peerDependencies", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
    dependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }

  const runtimeImports = ["@opentui/solid", "solid-js"]

  for (const dependency of runtimeImports) {
    // The TUI host provides its own OpenTUI/solid instances; shipping a
    // second copy in dependencies would break rendering across them.
    expect(packageJson.peerDependencies?.[dependency]).toBeString()
    expect(packageJson.dependencies?.[dependency]).toBeUndefined()
    // Local development keeps its own copies for typecheck and tests.
    expect(packageJson.devDependencies?.[dependency]).toBeString()
  }
})

test("the plugin entrypoint resolves under every export condition", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
    main?: string
    exports?: Record<string, Record<string, string>>
  }

  // The host resolves the plugin entrypoint through the exports map, and it
  // falls back to the main entry when the subpath does not resolve. A
  // subpath that only answers to the "import" condition leaves the plugin
  // unresolvable for a host that resolves it under another condition, and the
  // host reports that as "Plugin entrypoint not found" and then as "Location
  // plugins did not finish activating".
  for (const subpath of ["./server", "./tui"]) {
    const conditions = packageJson.exports?.[subpath]
    expect(conditions).toBeDefined()
    const target = conditions?.default
    expect(target).toBeString()
    if (typeof target !== "string") throw new Error(`expected ${subpath} to have a default condition`)
    expect(existsSync(target)).toBe(true)
  }

  // The main entry is the fallback the host uses when the subpath does not
  // resolve, so it has to point at the bundle.
  expect(packageJson.main).toBe("./dist/server.js")
  expect(existsSync("./dist/server.js")).toBe(true)
})

test("engines.opencode covers the V2 beta line and the V1 floor while excluding older stable releases", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
    engines?: Record<string, string>
  }
  const range = packageJson.engines?.opencode
  expect(range).toBeString()
  if (typeof range !== "string") throw new Error("expected engines.opencode to be a string range")

  // The range must cover the 0.0.0-beta-* V2 line and the V1 floor 1.17.1
  // while excluding unsupported stable pre-1.17.1 releases.
  for (const version of ["0.0.0-beta-0", "0.0.0-beta-19425", "1.17.1", "1.17.2", "2.0.0"]) {
    expect(satisfies(version, range)).toBe(true)
  }
  for (const version of ["0.0.0", "0.0.1", "0.5.0", "1.0.0", "1.17.0"]) {
    expect(satisfies(version, range)).toBe(false)
  }
})
