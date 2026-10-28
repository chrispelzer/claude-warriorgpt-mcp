# Contributing

Contributions are welcome. Bug reports, fixes, and docs are all useful.

## Setup

- Node 22 or newer.
- The project is plain Node with no npm dependencies. Keep it that way. Use only `node:` built-in modules.
- Do not add runtime or dev dependencies without opening an issue first.

Clone the repo, then run:

```
npm test
```

There is no build step and no `npm install` needed.

To try local changes in Claude Code, from the clone run:

```
npm install -g .
```

Reinstall after changes, then start a new Claude Code session and check `/mcp`.

## Layout

- `warriorgpt-mcp.mjs`: the MCP server (stdio JSON-RPC) providing `ask_warriorgpt`.
- `warriorgpt-delegate.mjs`: runner that hands tasks to OpenCode workers in a git worktree.
- `common.mjs`: shared API base, default model, API key lookup, state paths.
- `delegate/`: worker rules (`WORKER_RULES.md`) and the OpenCode agent definitions (`opencode/agents/`) the runner uses.
- `warriorgpt-mode.md`: the system prompt appended by the `claude-warriorgpt` alias.
- `docs/`: agent setup guide and OpenCode subagent guide.
- `test/`: `node:test` suites.

`server.test.mjs` runs the server as a child process with `test/mock-fetch.mjs` preloaded via `--import`. It replaces `fetch` with a canned WarriorGPT reply, so tests never call the real API and need no API key.

`delegate.test.mjs` uses `test/fake-opencode.mjs` in place of `opencode run`.

Tests point `HOME`, `USERPROFILE`, and `LOCALAPPDATA` at a temp dir so the usage log stays out of the real home directory.

## Tests

Add or update tests for behavior changes. Follow the existing helpers in the sibling test file.

CI runs `npm test` on ubuntu, macos, and windows with Node 22, 24, and 26 in GitHub Actions (`.github/workflows/test.yml`). Code must work on all three OSes. Watch:

- path separators
- Windows line endings: files with CRLF must keep them
- npm installs commands on Windows as `.cmd` files

## Docs

If a change makes `README.md` or a file in `docs/` wrong, update it in the same pull request. Keep `warriorgpt-mode.md` and docs ASCII-only too.

## Commits and pull requests

Use Conventional Commits subjects:

```
type(scope): summary
```

For example: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `ci:`, `chore:`.

Keep the body to a few lines on why. One concern per commit.

Branch off `main`, open a pull request against `main`, and make sure `npm test` passes.

Keep code comments short, and add them only when the why is not obvious.

## Reporting issues

Include:

- OS
- Node version from `node --version`
- how the server was registered, such as the `claude mcp add ...` command, without the key
- the model used
- the error text

Never paste your WarriorGPT API key into an issue or log.

## License

Contributions are under the MIT license. See [LICENSE](LICENSE).
