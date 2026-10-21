import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

type ProbeResult = { role: string; sessionID: string; status: string | null; goals: string[] }

function runProbe(role: string, stateFile: string, iterations: number) {
  const proc = Bun.spawn(
    [process.execPath, join(import.meta.dir, "..", "scripts", "state-concurrency-probe.ts"), role, stateFile, String(iterations)],
    {
      env: { ...process.env, OPENCODE_GOAL_STATE_PATH: stateFile },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  return new Promise<ProbeResult>((resolve, reject) => {
    proc.exited.then(async (code) => {
      const stdout = await new Response(proc.stdout).text()
      if (code !== 0) {
        const stderr = await new Response(proc.stderr).text()
        reject(new Error(`probe ${role} exited with ${code}: ${stderr || stdout}`))
        return
      }
      try {
        resolve(JSON.parse(stdout.trim().split("\n").at(-1)!) as ProbeResult)
      } catch {
        reject(new Error(`probe ${role} produced no result: ${stdout}`))
      }
    })
  })
}

test("two plugin instances writing the shared state file do not lose each other's goals", async () => {
  // Every OpenCode directory runs its own plugin instance against the same
  // goals.json. Without a cross-process guard, the second writer overwrites
  // the first writer's state, which can drop a whole goal.
  const dir = await mkdtemp(join(tmpdir(), "opencode-goal-plugin-concurrency-"))
  const stateFile = join(dir, "goals.json")
  const previous = process.env.OPENCODE_GOAL_STATE_PATH
  process.env.OPENCODE_GOAL_STATE_PATH = stateFile
  try {
    // The first probe has to be inside its read-modify-write cycle when the
    // second one writes, so the second probe starts once the first is well
    // into its loop.
    const first = runProbe("a", stateFile, 300)
    await new Promise((resolve) => setTimeout(resolve, 150))
    const second = runProbe("b", stateFile, 1)
    const [a, b] = await Promise.all([first, second])

    // Neither probe may lose its own goal: a null status means the goal was
    // deleted by the other instance's write.
    expect(a.status).not.toBeNull()
    expect(b.status).not.toBeNull()

    // The shared state has to hold both goals once both instances are done.
    const { getAllGoals } = await import("../src/state")
    const all = await getAllGoals()
    const ids = all.goals.map((goal) => goal.sessionID)
    expect(ids).toContain("ses_probe_a")
    expect(ids).toContain("ses_probe_b")
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_GOAL_STATE_PATH
    else process.env.OPENCODE_GOAL_STATE_PATH = previous
    await rm(dir, { recursive: true, force: true })
  }
  // The probes spawn processes and write the state file hundreds of times, so
  // the test needs more than Bun's default per-test timeout.
}, 60_000)
