// Runs the installed OpenCode V2 binary against a deterministic local model.
// No real provider credentials, shared service, or user goal state are used.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { cp, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const root = await mkdtemp(join(tmpdir(), "goal-v2-lifecycle-smoke-"))
const project = join(root, "project")
await mkdir(project)
const target = process.argv[2] ?? "."
const registryPackage = target.startsWith("@")
const packagePath = registryPackage ? target : resolve(target)
let modelCalls = 0
let continuationCalls = 0
const model = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const body = await request.json() as {
      messages: Array<{ role: string; content?: unknown }>
      tools?: Array<{ function: { name: string } }>
      stream?: boolean
    }
    modelCalls++
    await writeFile(join(root, `model-request-${modelCalls}.json`), JSON.stringify(body))
    const messages = body.messages
    const last = messages.at(-1)
    const continuationCount = messages.filter((message) => message.role === "user" &&
      JSON.stringify(message.content).includes("Continue working toward the active session goal")).length
    const hasContinuation = continuationCount > 0
    if (hasContinuation) continuationCalls++
    const toolName = hasContinuation ? "update_goal" : "create_goal"
    const tool = body.tools?.find((entry) => entry.function.name === toolName || entry.function.name.endsWith(`_${toolName}`))
    const call = last?.role === "user" && tool && (!hasContinuation || continuationCount >= 2)
    const args = hasContinuation
      ? { status: "complete", evidence: "A native V2 execution settled and the plugin automatically sent the next goal prompt." }
      : { objective: "Verify native V2 goal continuation with the local fixture model", max_auto_turns: 3 }
    const delta = call
      ? { role: "assistant", tool_calls: [{ index: 0, id: `call_${modelCalls}`, type: "function", function: { name: tool.function.name, arguments: JSON.stringify(args) } }] }
      : { role: "assistant", content: `Isolated fixture milestone ${modelCalls} is verified. The active goal still requires the next automatic continuation turn.` }
    const finish = call ? "tool_calls" : "stop"
    const chunk = (choices: unknown[], usage?: unknown) => ({ id: `chatcmpl_${modelCalls}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "fixture", choices, ...(usage ? { usage } : {}) })
    const usage = { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 }
    if (!body.stream) {
      return Response.json({ ...chunk([]), object: "chat.completion", choices: [{ index: 0, message: delta, finish_reason: finish }], usage })
    }
    return new Response([
      chunk([{ index: 0, delta, finish_reason: null }]),
      chunk([{ index: 0, delta: {}, finish_reason: finish }], usage),
    ].map((item) => `data: ${JSON.stringify(item)}\n\n`).join("") + "data: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" },
    })
  },
})

try {
await mkdir(join(root, "config/opencode"), { recursive: true })
const localPluginPath = join(root, "plugin")
if (!registryPackage) {
  await mkdir(localPluginPath)
  await writeFile(join(localPluginPath, "server.ts"),
    `export { default } from ${JSON.stringify(pathToFileURL(join(packagePath, "dist/server.js")).href)}\n`)
}
await writeFile(join(root, "config/opencode/opencode.json"), JSON.stringify({
  ...(!registryPackage ? { plugins: [localPluginPath] } : {}),
  model: "fixture/fixture",
  snapshots: false,
  providers: {
    fixture: {
      env: ["FIXTURE_API_KEY"],
      package: "@opencode-ai/ai/providers/openai-compatible",
      settings: { baseURL: `http://127.0.0.1:${model.port}/v1` },
      models: { fixture: { name: "Local fixture", limit: { context: 100000, output: 1000 } } },
    },
  },
}))

// Use a clean environment, not a spread of process.env (which may carry a live
// OPENCODE_DB, server connection settings, provider credentials, or config).
const env = {
  PATH: process.env.PATH!,
  HOME: join(root, "home"),
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_DATA_HOME: join(root, "data"),
  XDG_STATE_HOME: join(root, "state"),
  XDG_CACHE_HOME: join(root, "cache"),
  OPENCODE_DB: join(root, "opencode.db"),
  OPENCODE_GOAL_STATE_PATH: join(root, "goals.json"),
  OPENCODE_PASSWORD: crypto.randomUUID(),
  FIXTURE_API_KEY: crypto.randomUUID(),
}
const binary = process.env.OPENCODE_V2_BIN ?? "opencode2"
const versionResult = Bun.spawnSync([binary, "--version"], { env, stdout: "pipe", stderr: "pipe" })
assert.equal(versionResult.exitCode, 0, "Cannot read the isolated OpenCode binary version")
const hostVersion = new TextDecoder().decode(versionResult.stdout).trim()
const commandField = hostVersion.includes("0.0.0-beta-") ? "command" : "name"
if (registryPackage) {
  const install = Bun.spawn([binary, "plugin", "add", packagePath], { cwd: project, env, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([new Response(install.stdout).text(), new Response(install.stderr).text(), install.exited])
  await writeFile(join(root, "install.log"), stdout + stderr)
  if (code !== 0) {
    model.stop(true)
    throw new Error(`Plugin installation failed; inspect ${root}/install.log`)
  }
}
const child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
  cwd: project, env, stdio: ["ignore", "pipe", "pipe"],
  // POSIX detached starts a private process group, including inherited-pipe children.
  detached: process.platform !== "win32",
})
let output = ""
let spawnError: Error | undefined
const exited = new Promise<void>((resolve) => {
  child.once("exit", () => resolve())
  child.once("error", (error) => { spawnError = error; resolve() })
})
for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding("utf8")
  stream.on("data", (chunk: string) => { output += chunk })
  stream.on("error", (error) => { spawnError ??= error })
}
async function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Smoke cleanup timed out")), ms)
    })])
  } finally {
    clearTimeout(timer)
  }
}
function isMissingProcess(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH"
}
async function stopServerTree() {
  if (child.pid === undefined) return
  if (process.platform === "win32") {
    if (child.exitCode != null || child.signalCode != null) {
      throw new Error("Cannot verify Windows descendants after the server exited")
    }
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" })
    try {
      await bounded(new Promise<void>((resolve, reject) => {
        killer.once("error", reject)
        killer.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`taskkill failed: ${code}`)))
      }), 3000)
    } finally {
      killer.kill()
      killer.unref()
    }
  } else {
    const groupExists = () => {
      try { process.kill(-child.pid!, 0); return true } catch (error) {
        if (isMissingProcess(error)) return false
        if (typeof error === "object" && error !== null && "code" in error && error.code === "EPERM") return true
        throw error
      }
    }
    try { process.kill(-child.pid, "SIGKILL") } catch (error) {
      if (!isMissingProcess(error)) throw error
    }
    const stopDeadline = Date.now() + 3000
    while (groupExists()) {
      if (Date.now() >= stopDeadline) throw new Error("Server process group survived cleanup")
      await Bun.sleep(25)
    }
  }
  await bounded(exited, 1000)
}
let cleanup: Promise<void> | undefined
const stop = () => cleanup ??= stopServerTree()
let interruptionCode: number | undefined
const interrupt = (code: number) => {
  interruptionCode ??= code
  void stop().catch((error: unknown) => console.error("Smoke cleanup failed:", error)).finally(() => {
    child.stdout.destroy()
    child.stderr.destroy()
    model.stop(true)
    process.exit(interruptionCode)
  })
}
const onInterrupt = () => interrupt(130)
const onTerminate = () => interrupt(143)
const onHangup = () => interrupt(129)
const onQuit = () => interrupt(131)
process.once("SIGINT", onInterrupt)
process.once("SIGTERM", onTerminate)
if (process.platform !== "win32") {
  process.once("SIGHUP", onHangup)
  process.once("SIGQUIT", onQuit)
}
const deadline = Date.now() + Number(process.env.OPENCODE_SMOKE_TIMEOUT_MS ?? 30000)
let lastStage: string | undefined
const waitFor = async (stage: string, check: () => boolean | Promise<boolean>, diagnose?: () => string) => {
  lastStage = stage
  while (Date.now() < deadline) {
    if (await check()) return
    if (spawnError) throw spawnError
    if (child.exitCode != null || child.signalCode != null) throw new Error(`Private V2 exited: ${output.slice(-4000)}`)
    await Bun.sleep(50)
  }
  const details = diagnose?.()
  const observed = `modelCalls=${modelCalls}, continuationCalls=${continuationCalls}${details ? `; ${details}` : ""}`
  throw new Error(`Smoke timeout at stage "${stage}"; ${observed}; logs=${root}/server.log`)
}
let summary: Record<string, unknown> | undefined
let failure: unknown
try {
  await waitFor("server-ready", () => /http:\/\/127\.0\.0\.1:\d+/.test(output))
  const base = output.match(/http:\/\/127\.0\.0\.1:\d+/)![0]
  const api = async (path: string, data?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method: data === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", authorization: `Basic ${btoa(`opencode:${env.OPENCODE_PASSWORD}`)}` },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    })
    assert(response.ok, `${path}: ${response.status} ${await response.clone().text()}`)
    const text = await response.text()
    return text ? JSON.parse(text) : undefined
  }
  const created = await api("/api/session", { location: { directory: project }, title: "Isolated lifecycle smoke", model: { providerID: "fixture", id: "fixture" }, agent: "build" }) as { data: { id: string } }
  const sessionID = created.data.id
  // The user's shared server hosts many locations. Activating a second plugin
  // instance must not duplicate continuation delivery for the first location.
  const otherProject = join(root, "other-project")
  await mkdir(otherProject)
  for (const directory of [otherProject, project]) {
    // Reading commands boots location services on stable and preview hosts.
    await api(`/api/command?location%5Bdirectory%5D=${encodeURIComponent(directory)}`)
    const artifact = directory === project ? "plugins.json" : "other-plugins.json"
    await waitFor(`plugin-active (${artifact})`, async () => {
      const plugins = await api(`/api/plugin?location%5Bdirectory%5D=${encodeURIComponent(directory)}`) as {
        data: Array<{ id?: string; state?: { status: string; error?: string } }>
      }
      await writeFile(join(root, artifact), JSON.stringify(plugins))
      return plugins.data.some((plugin) => plugin.id === "local.goal-mode.server" && plugin.state?.status === "active")
    }, () => `plugin inventory=${join(root, artifact)}`)
  }
  await writeFile(join(root, "config.json"), JSON.stringify(await api(`/api/config?location%5Bdirectory%5D=${encodeURIComponent(project)}`)))
  const commands = await api(`/api/command?location%5Bdirectory%5D=${encodeURIComponent(project)}`) as { data: Array<{ name: string }> }
  assert(commands.data.some((command) => command.name === "goal"))
  // Stable V2 reads `name`; 0.0.0 beta hosts still read `command`.
  await api(`/api/session/${sessionID}/command`, {
    [commandField]: "goal",
    text: "Create a goal for the fixture milestone. Keep it active until the automatic continuation arrives.",
  })
  let state: { goals: Record<string, { status: string; autoTurns: number }> } | undefined
  // Last-observed values for each final condition, so a timeout can report
  // which one was stuck instead of failing opaquely.
  let lastOutcome: string | undefined
  let lastGoalStatus: string | undefined
  let lastAutoTurns: number | undefined
  let lastActiveSessionActive: boolean | undefined
  await waitFor("goal-complete", async () => {
    const current = await api(`/api/session/${sessionID}`) as { data: { outcome?: string } }
    lastOutcome = current.data.outcome
    if (current.data.outcome === "failed") {
      const exported = await api(`/api/session/${sessionID}/export`)
      await writeFile(join(root, "failed-session.json"), JSON.stringify(exported))
      throw new Error(`Fixture session failed; inspect ${root}/failed-session.json`)
    }
    try { state = JSON.parse(await readFile(env.OPENCODE_GOAL_STATE_PATH, "utf8")) } catch { return false }
    lastGoalStatus = state?.goals[sessionID]?.status
    lastAutoTurns = state?.goals[sessionID]?.autoTurns
    if (state?.goals[sessionID]?.status !== "complete") return false
    const active = await api("/api/session/active") as { data: Record<string, unknown> }
    lastActiveSessionActive = sessionID in active.data
    return !lastActiveSessionActive
  }, () => {
    const parts = [
      `goal status=${lastGoalStatus ?? "none"}`,
      `autoTurns=${lastAutoTurns ?? "none"}`,
      `outcome=${lastOutcome ?? "unknown"}`,
      `stillActive=${lastActiveSessionActive ?? "unknown"}`,
    ]
    return parts.join(", ")
  })
  assert.equal(state!.goals[sessionID]!.autoTurns, 2)
  assert(continuationCalls > 0)
  const arraysSession = await api("/api/session", {
    location: { directory: project },
    title: "Isolated command arrays smoke",
    model: { providerID: "fixture", id: "fixture" },
    agent: "build",
  }) as { data: { id: string } }
  await api(`/api/session/${arraysSession.data.id}/command`, {
    [commandField]: "goal",
    text: "Create a goal for the arrays-present command smoke.",
    files: [],
    agents: [],
    skills: [],
  })
  await waitFor("arrays-goal-registered", async () => {
    try { state = JSON.parse(await readFile(env.OPENCODE_GOAL_STATE_PATH, "utf8")) } catch { return false }
    return state?.goals[arraysSession.data.id] != null
  })
  summary = {
    result: "PASS",
    packagePath,
    hostVersion,
    sessionID,
    modelCalls,
    continuationCalls,
    status: state!.goals[sessionID]!.status,
    autoTurns: state!.goals[sessionID]!.autoTurns,
    artifacts: root,
  }
} catch (error) {
  failure = error
  console.error(error)
} finally {
  try {
    await writeFile(join(root, "server.log"), output)
  } catch (error) {
    failure ??= error
  }
  try {
    await stop()
  } catch (error) {
    console.error("Smoke cleanup failed:", error)
    failure ??= error
  } finally {
    child.stdout.destroy()
    child.stderr.destroy()
    child.unref()
    process.removeListener("SIGINT", onInterrupt)
    process.removeListener("SIGTERM", onTerminate)
    if (process.platform !== "win32") {
      process.removeListener("SIGHUP", onHangup)
      process.removeListener("SIGQUIT", onQuit)
    }
    model.stop(true)
  }
  // On failure, preserve diagnostics before the temp root disappears: a bare
  // timeout cannot say which final condition was stuck, and CI uploads the
  // copied directory as an artifact via OPENCODE_SMOKE_ARTIFACTS_DIR.
  if (failure !== undefined) {
    try {
      const summary = {
        failed: true,
        stage: lastStage ?? "unknown",
        modelCalls,
        continuationCalls,
        deadlineAtMs: deadline,
        finishedAt: Date.now(),
      }
      await writeFile(join(root, "failure-summary.json"), JSON.stringify(summary))
      const artifactsDir = process.env.OPENCODE_SMOKE_ARTIFACTS_DIR
      if (artifactsDir) {
        await mkdir(artifactsDir, { recursive: true })
        await cp(root, artifactsDir, { recursive: true })
      }
    } catch (error) {
      // Artifact preservation must never mask the original failure.
      console.error(`Failed to preserve smoke artifacts: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

if (interruptionCode !== undefined) process.exit(interruptionCode)
if (failure !== undefined) throw failure
console.log(JSON.stringify(summary, null, 2))
} finally {
  model.stop(true)
}
