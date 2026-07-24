# slash/goal for OpenCode

This context defines the language for goal-mode behavior across OpenCode surfaces. It exists to keep server capabilities, terminal UI behavior, and browser/desktop UI expectations distinct.

## Language

**Goal Mode**:
A long-running session workflow where the agent tracks one explicit objective until it is completed, blocked, or cleared.
_Avoid_: autonomous mode, task mode

**Server Functionality**:
Goal Mode behavior provided by OpenCode server hooks, commands, tools, persistence, compaction context, and idle continuation.
_Avoid_: backend UI, server UI

**Surface Indicator**:
A lightweight web or desktop UI affordance that shows the current Goal Mode state without requiring the terminal sidebar.
_Avoid_: TUI sidebar, full goal dashboard

**Slash Command**:
The `/goal` command used from an OpenCode conversation to create, view, complete, block, or clear a Goal Mode objective.
_Avoid_: command palette action

## Relationships

- **Goal Mode** is driven by **Server Functionality** across OpenCode surfaces.
- A **Slash Command** is the primary user entrypoint for **Goal Mode** in web and desktop.
- A **Surface Indicator** reflects **Goal Mode** state but does not own it.

## Example Dialogue

> **Dev:** "Do we need the same sidebar from the terminal in web and desktop?"
> **Domain expert:** "No. We need Goal Mode to work through `/goal`, plus a lightweight Surface Indicator where the frontend supports it."

## Flagged Ambiguities

- "habilitar el plugin" was resolved as enabling **Server Functionality** plus a **Slash Command** and **Surface Indicator** for web/desktop, not porting the full TUI sidebar.
