# Goal Mode Improvement Plan (Superseded)

This planning snapshot is retained only as project history. The native-parity implementation now lives in `src/`, and the current behavioral contract is documented in `README.md`, `COMPATIBILITY.md`, and `AGENTS.md`.

The original plan is no longer authoritative because it described an earlier compatibility design with the legacy `unmet` status, extra model-facing tools, and broader model-controlled lifecycle transitions. The implemented contract instead follows the current Codex goal extension:

- Public tools are exactly `get_goal`, `create_goal`, and `update_goal`.
- Terminal goal states are `complete` and `blocked`; persisted `unmet` values are migration input only.
- The model can mark only `complete` or `blocked`. User/runtime code owns edit, pause, resume, clear, and limit states.
- A blocked transition requires at least three goal turns in the current run plus the native semantic blocker audit.
- Token budgets are opt-in only when the user explicitly requests one; no arbitrary continuation cap is enabled by default.
- OpenCode API compatibility and the unavoidable slash-command turn boundary are maintained in `COMPATIBILITY.md`.

Use the repository tests and the release gate in `AGENTS.md` for any future changes. Do not implement work directly from the obsolete design described by older revisions of this file.
