# claude-warriorgpt-mcp

An MCP server that gives [Claude Code](https://code.claude.com/) one tool, `ask_warriorgpt`, which calls Wayne State's [WarriorGPT](https://warriorgpt.wayne.edu/) API directly. Your Claude Code session stays on your Claude plan; only the tool call goes to WarriorGPT, so routine code generation does not count against your Claude usage.

It is a single Node file with no dependencies and works on macOS, Linux, and Windows.

## Requirements

- Claude Code
- Node 18 or newer
- A WarriorGPT API key from https://warriorgpt.wayne.edu/developer/api-key

## Install

To have Claude Code do it for you, tell it: "Follow the setup instructions at https://github.com/chrispelzer/claude-warriorgpt-mcp/blob/main/docs/agent-setup.md". It checks what is already done, runs the steps below, and stops for the ones only you can do, like entering your API key.

To install by hand:

1. Store your API key. The server reads the `WARRIORGPT_API_KEY` environment variable first, then falls back to the system keyring on macOS and Linux.

   **macOS** (Keychain). Run this and paste the key at the hidden prompt (`-w` must come last):

   ```
   security add-generic-password -U -a "$USER" -s warriorgpt-api-key -w
   ```

   **Linux** (Secret Service, e.g. GNOME Keyring or KWallet; `secret-tool` comes from the `libsecret-tools` or `libsecret` package). Paste the key at the prompt:

   ```
   secret-tool store --label="WarriorGPT API key" service warriorgpt-api-key
   ```

   **Windows** (user environment variable). In PowerShell, paste the key at the prompt, then open a new terminal so the variable is picked up:

   ```
   [Environment]::SetEnvironmentVariable('WARRIORGPT_API_KEY', (Read-Host 'WarriorGPT API key'), 'User')
   ```

   On any system you can instead export `WARRIORGPT_API_KEY` from your shell profile, as long as Claude Code is started from that shell.

2. Install the server globally:

   ```
   npm install -g github:chrispelzer/claude-warriorgpt-mcp
   ```

3. Register it with Claude Code for all projects.

   macOS and Linux:

   ```
   claude mcp add --scope user warriorgpt -- warriorgpt-mcp
   ```

   Windows (npm installs the command as a `.cmd` file, which needs `cmd /c` to start):

   ```
   claude mcp add --scope user warriorgpt -- cmd /c warriorgpt-mcp
   ```

4. Start a new Claude Code session and check `/mcp` shows `warriorgpt` as connected.

To update, rerun the `npm install -g` command; append `#<commit or tag>` to pin a version. If you manage Node with a version manager (asdf, nvm, fnm), the command is installed for the current Node version only, so reinstall after switching versions.

## The tool

`ask_warriorgpt` sends a prompt to a WarriorGPT model and returns its reply. The model cannot read your repo or run commands, so give it everything it needs.

| Argument | Description |
|---|---|
| `prompt` | The task or question (required). |
| `model` | WarriorGPT model id. Default `local.qwen3.8-27b`. |
| `system` | Optional system prompt. |
| `context_files` | Absolute paths of files the server reads and attaches. |
| `output_file` | Absolute path. The reply is written there (overwriting) and only a short summary comes back. |
| `files` | Absolute paths the model may create or change, for multi-file tasks. Existing files are attached automatically and edited in place. Not with `output_file`. |
| `max_tokens` | Max output tokens, default 32768. A reply cut off at this limit is reported as an error and nothing is written. |

`context_files`, `output_file`, and `files` are what save Claude usage: file contents go from disk to WarriorGPT and back without passing through Claude. Claude should still read and check what was written.

With `files`, the model replies with one block per file: the full contents for a new file, or search/replace edits for an existing one, so a small change to a large file costs a few lines instead of a rewrite. The server checks every block before writing anything. If a block names a file not in `files`, edits a file that does not exist, or has search text that is missing or matches more than one place, nothing is written and the error lists each problem, so Claude can retry with a sharper prompt. Files with Windows line endings keep them.

Models:

- `local.qwen3.8-27b`: 262k context, best general coder (default)
- `local.gpt-oss-120b`: 131k context, stronger reasoning, slower
- `local.laguna-s-2.1`: 131k context; may not be reachable on the gateway yet
- `local.gemma-4-31b`: 131k context

## Configuration

| Variable | Purpose |
|---|---|
| `WARRIORGPT_API_KEY` | API key. If unset, the server reads the `warriorgpt-api-key` item from the macOS Keychain or the Linux Secret Service. |
| `WARRIORGPT_MODEL` | Default model when a call does not pass `model`. |

Pass variables at registration with `claude mcp add ... -e WARRIORGPT_MODEL=local.gpt-oss-120b -- ...`. Avoid passing the API key this way: Claude Code stores it in plain text in its config file.

## Usage log

Each call appends `{ts, session, model, in, out}` to `usage.jsonl` in the state directory, where `session` is the Claude Code session id. While a request is running, an `active-<session>` file exists there. A status line script can read both to show WarriorGPT activity and token totals.

The state directory is `~/.local/share/warriorgpt-mcp` on macOS and Linux, and `%LOCALAPPDATA%\warriorgpt-mcp` on Windows.

## Compared with OpenCode

You can also hand WarriorGPT work through an [OpenCode](https://opencode.ai/) subagent, which can search the repo and run code to check itself but costs far more per task. Use `ask_warriorgpt` when you can name the files involved. [docs/opencode-subagent.md](docs/opencode-subagent.md) covers setup, trade-offs, and a benchmark of the two.

## Telling Claude when to use it

Claude sees the tool description, but works best with a short rule in your `CLAUDE.md`, for example:

> Use `ask_warriorgpt` for small, fully specified code generation (boilerplate, a straightforward function, tests for existing code). Attach inputs with `context_files`; set `output_file` for one new file, or list every file to create or change in `files`; then read and check the result. Keep design, debugging, and subtle logic with Claude.

### Only in some sessions: a `claude-warriorgpt` alias

A rule in `CLAUDE.md` applies to every session. To delegate only when you choose to, put the rule in its own file and start Claude Code with it appended to the system prompt. Plain `claude` sessions are unaffected.

1. Copy [`warriorgpt-mode.md`](warriorgpt-mode.md), which the npm install includes, to `~/.claude/`. It tells Claude which tasks to send to WarriorGPT and which to keep. Edit your copy to taste; rerun the copy after an update to pick up changes.

   macOS and Linux:

   ```
   cp "$(npm root -g)/claude-warriorgpt-mcp/warriorgpt-mode.md" ~/.claude/
   ```

   Windows (PowerShell):

   ```
   Copy-Item "$(npm root -g)\claude-warriorgpt-mcp\warriorgpt-mode.md" "$HOME\.claude\"
   ```

2. Add the alias to your shell config.

   macOS and Linux (`~/.zshrc` or `~/.bashrc`):

   ```
   alias claude-warriorgpt='claude --append-system-prompt-file ~/.claude/warriorgpt-mode.md'
   ```

   Windows (PowerShell profile; open it with `notepad $PROFILE`):

   ```
   function claude-warriorgpt { claude --append-system-prompt-file "$HOME\.claude\warriorgpt-mode.md" @args }
   ```

3. Open a new terminal and run `claude-warriorgpt`. Other arguments pass through, so `claude-warriorgpt --continue` works as usual.

If you also set up the [OpenCode subagent](docs/opencode-subagent.md), the same mode file is a good place for its rule, so the subagent is only used in these sessions too.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| "No WarriorGPT API key" | The key is not set where the server looks. Redo install step 1, then restart Claude Code from a new terminal. |
| `secret-tool: command not found` (Linux) | Install `libsecret-tools` (Debian/Ubuntu) or `libsecret` (Fedora/Arch), or use `WARRIORGPT_API_KEY` instead. |
| WarriorGPT 401 | The key is wrong or revoked. Create a new one and store it again. |
| WarriorGPT 500 on one model | That model is down on the gateway. Try another `model`. |
| 429 / `quota_exceeded` | Rate limit or quota. Wait, or let Claude do the task. |
| `/mcp` shows warriorgpt failed (Windows) | The server was registered without `cmd /c`. Remove it with `claude mcp remove warriorgpt` and redo install step 3. |
| `/mcp` shows warriorgpt failed | `warriorgpt-mcp` is not on Claude Code's PATH, often after switching Node versions. Reinstall, or register the full path from `which warriorgpt-mcp` (`where warriorgpt-mcp` on Windows). |

## License

[MIT](LICENSE)
