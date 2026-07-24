import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

test("published tui entrypoint keeps its runtime imports in dependencies", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }

  const runtimeImports = ["@opentui/solid", "solid-js"]

  for (const dependency of runtimeImports) {
    expect(packageJson.dependencies?.[dependency]).toBeString()
    expect(packageJson.devDependencies?.[dependency]).toBeUndefined()
  }
})

test("package metadata targets the stable OpenCode v1 plugin API", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
    name?: string
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
    engines?: Record<string, string>
    files?: string[]
  }

  expect(packageJson.name).toBe("slash-goal-for-opencode")
  expect(packageJson.peerDependencies?.["@opencode-ai/plugin"]).toBe(">=1.17.1 <2")
  expect(packageJson.dependencies?.["@opencode-ai/plugin"]).toBeUndefined()
  expect(packageJson.devDependencies?.["@opencode-ai/plugin"]).toBe("^1.18.3")
  expect(packageJson.engines?.opencode).toBe(">=1.17.1 <2")
  expect(packageJson.files).toContain("NOTICE")
  expect(packageJson.files).toContain("COMPATIBILITY.md")
})
