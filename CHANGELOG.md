# Changelog

## Unreleased

## 1.1.0 (2026-11-24)

The first tagged release. Install it with `npm install -g github:chrispelzer/claude-warriorgpt-mcp#v1.1.0`.

### Added

- `start_opencode_job`: the MCP server runs an OpenCode coding agent on a WarriorGPT model as a background job. The agent works in a git worktree on branch `dl/<name>` (or reads and reports with `mode: read`), and your uncommitted work comes along by default as a snapshot commit. Poll it, read it and cancel it with the existing job tools. Answer a worker's questions with `reply`. At most `WARRIORGPT_MAX_OPENCODE_JOBS` (default 2) run at once. OpenCode must be installed.
- Automatic OpenCode fallback: when a `start_warriorgpt_job` check never passes, the same job hands the task to an OpenCode worker, with a brief made from the prompt, the files, the check and the last failure. Set `opencode_fallback: false` to keep the old `fallback: opencode` answer.
- `warriorgpt-ask --keep-failed <dir>`: when the check never passes, the closest state's versions of the files are saved under `<dir>` before the restore, with a `CLOSEST.md` that says where they came from and how they scored.
- `warriorgpt-mcp` reports its real version (from `package.json`) in `initialize`.

### Changed

- `warriorgpt-delegate` is sealed to WarriorGPT. Its OpenCode config names only the WarriorGPT provider, and it leaves out your own OpenCode config, plugins, logins and other providers' API keys. A worker can therefore never run on your OpenCode Go or Zen subscription or on another provider's key.
- The `fallback: opencode` hint now points at `start_opencode_job`.
- A check that hits its timeout is no longer called a broken check. The model is told the output was cut off before the runner's summary, what usually causes a hang, and, in the tool loop, to run one failing test file itself to see why.

### Fixed

- The tool loop stops after 3 refused edits to files outside `files`, and names them. Before, it ran to the step cap on a task that needed a file it was not allowed to change.
- A check whose program is a Windows app execution alias (PowerShell 7 from the Store) is no longer refused as not found.
- The give-up hint for repeated 502 resets no longer contains the text that the network filter itself blocks. Any request that attached the README or `retry.mjs` used to be reset.
- A file deleted while an attempt copies the working tree (a lock or marker file, an editor's temp file, a build writing) is now left out of the copy instead of failing the attempt.
