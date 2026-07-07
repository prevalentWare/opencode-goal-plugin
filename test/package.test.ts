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
