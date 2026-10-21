// Concurrency probe for the shared goal state file.
//
// Every OpenCode directory runs its own plugin instance and every instance
// shares one goals.json, so two plugin instances can mutate the same file at
// the same time. This probe acts as one instance: it writes a goal and then
// keeps changing it, while another probe does the same. The test that drives
// this asserts that both sets of writes survive.
//
// Usage: bun scripts/state-concurrency-probe.ts <role> <stateFile> [iterations]
import { createGoal, getAllGoals, getGoal, setGoalStatus } from "../src/state"

const [, , role, stateFile, iterationsArg] = process.argv
if (!role || !stateFile) {
  console.error("usage: state-concurrency-probe.ts <role> <stateFile> [iterations]")
  process.exit(2)
}
const iterations = Number(iterationsArg ?? 200)
process.env.OPENCODE_GOAL_STATE_PATH = stateFile

const sessionID = `ses_probe_${role}`
await createGoal(sessionID, `goal written by the ${role} probe`, null)
// Start a little later for the second role so the two probes overlap.
if (role === "b") await new Promise((resolve) => setTimeout(resolve, 40))

for (let index = 0; index < iterations; index++) {
  await setGoalStatus(sessionID, index % 2 === 0 ? "active" : "paused", null)
}

const goal = await getGoal(sessionID)
const all = await getAllGoals()
console.log(
  JSON.stringify({
    role,
    sessionID,
    status: goal?.status ?? null,
    goals: all.goals.map((entry) => entry.sessionID).sort(),
  }),
)
