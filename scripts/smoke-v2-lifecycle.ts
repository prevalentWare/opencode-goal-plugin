// Runs the installed OpenCode V2 binary against a deterministic local model.
// No real provider credentials, shared service, or user goal state are used.
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
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

await mkdir(join(root, "config/opencode"), { recursive: true })
if (!registryPackage) {
  await mkdir(join(root, "config/opencode/plugins"))
  await writeFile(join(root, "config/opencode/plugins/goal.ts"), `export { default } from ${JSON.stringify(pathToFileURL(join(packagePath, "dist/server.js")).href)}\n`)
}
await writeFile(join(root, "config/opencode/opencode.json"), JSON.stringify({
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
  FIXTURE_API_KEY: "local-fixture-only",
}
const binary = process.env.OPENCODE_V2_BIN ?? "opencode2"
if (registryPackage) {
  const install = Bun.spawn([binary, "plugin", "add", packagePath], { cwd: project, env, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([new Response(install.stdout).text(), new Response(install.stderr).text(), install.exited])
  await writeFile(join(root, "install.log"), stdout + stderr)
  if (code !== 0) {
    model.stop(true)
    throw new Error(`Plugin installation failed; inspect ${root}/install.log`)
  }
}
const child = Bun.spawn([binary, "serve", "--hostname", "127.0.0.1", "--port", "0"], {
  cwd: project, env, stdout: "pipe", stderr: "pipe",
})
let output = ""
const consume = async (stream: ReadableStream<Uint8Array>) => {
  for await (const chunk of stream) output += new TextDecoder().decode(chunk)
}
const readers = Promise.all([consume(child.stdout), consume(child.stderr)])
const deadline = Date.now() + Number(process.env.OPENCODE_SMOKE_TIMEOUT_MS ?? 30000)
const waitFor = async (check: () => boolean | Promise<boolean>) => {
  while (Date.now() < deadline) {
    if (await check()) return
    if (child.exitCode != null) throw new Error(`Private V2 exited: ${output.slice(-4000)}`)
    await Bun.sleep(50)
  }
  throw new Error(`Smoke timeout; modelCalls=${modelCalls}, continuationCalls=${continuationCalls}; logs=${root}/server.log`)
}
try {
  await waitFor(() => /http:\/\/127\.0\.0\.1:\d+/.test(output))
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
  await api(`/api/plugin/await-activation?location%5Bdirectory%5D=${encodeURIComponent(otherProject)}`, {})
  await api(`/api/plugin/await-activation?location%5Bdirectory%5D=${encodeURIComponent(project)}`, {})
  const plugins = await api(`/api/plugin?location%5Bdirectory%5D=${encodeURIComponent(project)}`) as { data: Array<{ id?: string; state?: { status: string; error?: string } }> }
  await writeFile(join(root, "plugins.json"), JSON.stringify(plugins))
  await writeFile(join(root, "config.json"), JSON.stringify(await api(`/api/config?location%5Bdirectory%5D=${encodeURIComponent(project)}`)))
  assert(plugins.data.some((plugin) => plugin.id === "local.goal-mode.server" && plugin.state?.status === "active"), `Goal plugin did not activate; inspect ${root}/plugins.json`)
  const commands = await api(`/api/command?location%5Bdirectory%5D=${encodeURIComponent(project)}`) as { data: Array<{ name: string }> }
  assert(commands.data.some((command) => command.name === "goal"))
  await api(`/api/session/${sessionID}/command`, {
    command: "goal", text: "Create a goal for the fixture milestone. Keep it active until the automatic continuation arrives.",
    files: [], agents: [], skills: [],
  })
  let state: { goals: Record<string, { status: string; autoTurns: number }> } | undefined
  await waitFor(async () => {
    const current = await api(`/api/session/${sessionID}`) as { data: { outcome?: string } }
    if (current.data.outcome === "failed") {
      const exported = await api(`/api/session/${sessionID}/export`)
      await writeFile(join(root, "failed-session.json"), JSON.stringify(exported))
      throw new Error(`Fixture session failed; inspect ${root}/failed-session.json`)
    }
    try { state = JSON.parse(await readFile(env.OPENCODE_GOAL_STATE_PATH, "utf8")) } catch { return false }
    if (state?.goals[sessionID]?.status !== "complete") return false
    const active = await api("/api/session/active") as { data: Record<string, unknown> }
    return !(sessionID in active.data)
  })
  assert.equal(state!.goals[sessionID]!.autoTurns, 2)
  assert(continuationCalls > 0)
  console.log(JSON.stringify({ result: "PASS", packagePath, sessionID, modelCalls, continuationCalls, status: state!.goals[sessionID]!.status, autoTurns: state!.goals[sessionID]!.autoTurns, artifacts: root }, null, 2))
} finally {
  child.kill()
  await child.exited
  await readers
  await writeFile(join(root, "server.log"), output)
  model.stop(true)
}
