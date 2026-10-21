import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

type PackageJson = {
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  devDependencies?: Record<string, string>
}

function readPackageJson() {
  return JSON.parse(readFileSync("package.json", "utf8")) as PackageJson
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : []
  })
}

type ImportUsage = { specifier: string; typeOnly: boolean }

function collectImports(): ImportUsage[] {
  const usages: ImportUsage[] = []
  const pattern = /^\s*(?:import|export)\s+(type\s+)?[\s\S]*?\s+from\s+"([^"]+)"/gm
  for (const file of sourceFiles("src")) {
    const text = readFileSync(file, "utf8")
    for (const match of text.matchAll(pattern)) {
      const specifier = match[2]!
      // Node builtins and relative imports are not package dependencies.
      if (specifier.startsWith("node:") || specifier.startsWith(".")) continue
      usages.push({ specifier, typeOnly: Boolean(match[1]) })
    }
  }
  return usages
}

function matchesDependency(specifier: string, dependency: string) {
  return specifier === dependency || specifier.startsWith(`${dependency}/`)
}

test("runtime imports are covered by dependencies or peerDependencies", () => {
  const packageJson = readPackageJson()
  const dependencies = Object.keys(packageJson.dependencies ?? {})
  const peerDependencies = Object.keys(packageJson.peerDependencies ?? {})

  for (const { specifier, typeOnly } of collectImports()) {
    if (typeOnly) continue
    const covered = [...dependencies, ...peerDependencies].some((dependency) =>
      matchesDependency(specifier, dependency),
    )
    expect({ specifier, covered }).toEqual({ specifier, covered: true })
  }
})

test("declared dependencies are all used at runtime", () => {
  const packageJson = readPackageJson()
  const usages = collectImports().filter((usage) => !usage.typeOnly)

  for (const dependency of Object.keys(packageJson.dependencies ?? {})) {
    const used = usages.some((usage) => matchesDependency(usage.specifier, dependency))
    expect({ dependency, used }).toEqual({ dependency, used: true })
  }
})

test("type-only plugin types are not runtime dependencies", () => {
  const packageJson = readPackageJson()
  const usages = collectImports()

  // @opencode-ai/plugin is imported with `import type` only, so shipping it as
  // a runtime dependency would install its whole tree (@opentui/core, effect,
  // typescript, web-tree-sitter) for every host that installs this plugin.
  const typeOnlySpecs = usages.filter((usage) => usage.typeOnly).map((usage) => usage.specifier)
  const valueSpecs = usages.filter((usage) => !usage.typeOnly).map((usage) => usage.specifier)
  expect(typeOnlySpecs).toContain("@opencode-ai/plugin")
  expect(valueSpecs).not.toContain("@opencode-ai/plugin")
  expect(packageJson.dependencies?.["@opencode-ai/plugin"]).toBeUndefined()
  expect(packageJson.devDependencies?.["@opencode-ai/plugin"]).toBeString()
})

test("host-provided TUI peers are optional so npm does not install them", () => {
  const packageJson = readPackageJson()

  for (const peer of ["@opentui/solid", "solid-js"]) {
    expect(packageJson.peerDependencies?.[peer]).toBeString()
    // The TUI host supplies its own OpenTUI/solid instances. A required peer
    // makes npm install a second copy into the plugin's install tree, which
    // stalls plugin preparation and breaks rendering across two runtimes.
    expect(packageJson.peerDependenciesMeta?.[peer]?.optional).toBe(true)
  }
})
