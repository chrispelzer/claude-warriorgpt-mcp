# claude-warriorgpt-mcp

An MCP server that gives [Claude Code](https://code.claude.com/) one tool, `ask_warriorgpt`, which calls Wayne State's [WarriorGPT](https://warriorgpt.wayne.edu/) API directly. Your Claude Code session stays on your Claude plan; only the tool call goes to WarriorGPT, so routine code generation does not count against your Claude usage.

It is plain Node with no dependencies and works on macOS, Linux, and Windows.

## Requirements

- Claude Code
- Node 22 or newer
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

`ask_warriorgpt` sends a prompt to a WarriorGPT model and returns its reply. Give it everything it needs: on its first try the model sees only what you attach. (With `check`, a missed first try gives it tools to read the files in scope and run code; see below.)

| Argument | Description |
|---|---|
| `prompt` | The task or question (required). |
| `model` | WarriorGPT model id. Default `local.qwen3.8-27b`. |
| `system` | Optional system prompt. |
| `context_files` | Absolute paths of files the server reads and attaches. |
| `output_file` | Absolute path. The reply is written there (overwriting) and only a short summary comes back. |
| `files` | Absolute paths the model may create or change, for multi-file tasks. Existing files are attached automatically and edited in place. Not with `output_file`. |
| `max_tokens` | Max output tokens for the first reply, default 16384. A reply cut off at this limit is reported as an error and nothing is written. |
| `loop_max_tokens` | Max output tokens for each tool-loop step, default 8192. The loop lane and verify steps run to a 16,384-token cap. |
| `think_budget` | With `files` or `output_file`: tokens of thinking allowed before the first reply has written anything, default 4096; each retry after a cut-off doubles it, up to 16,384. 0 turns it off (see below). |
| `loop_think_budget` | The same for tool-loop steps, default 1536. The loop lane and verify steps think without a cutoff. |
| `loop_thinking` | `auto` (default), `on` or `off`: when to ask the server to skip thinking on loop and verify steps. `auto` asks after the first runaway. |
| `check` | With `files`: a shell command run after the edits are written, for example `npm test`. Exit 0 counts as passing. A plain `node ...` command (no pipes, variables, unquoted globs or other shell syntax) is spawned directly with the server's own Node binary, which skips the shell. |
| `cwd` | Folder the check runs in. Default: the folder that holds all of `files`. |
| `loop` | With `check`: after a missed first attempt, switch to the tool loop (default `true`). `false` retries whole replies instead, up to `max_attempts`. |
| `parallel` | With `check`: one-shot attempts sent at once, each checked in its own copy of the tree, raced by the loop lane from the start; the first to pass wins and the rest are cancelled (1 by default, at most 6). See below. |
| `loop_lane` | With `check`: a tool-loop lane races the one-shot attempts from the start, in its own copy of the tree (default `true`). `false`: the one-shot attempts go first, then the loop starts from their best. |
| `max_steps` | With `check`: tool-loop steps, default 30, at most 40 (CLI: `--max-steps`). A result that ran out says so with a `note:` line. |
| `verify` | With `check`: after it passes, the model runs a short self-check that tests the spec rules the check misses and fixes genuine failures (see below). Default `false`. |
| `max_attempts` | With `check` and `loop: false`: tries, 3 by default, at most 5. |
| `check_timeout_s` | Seconds before the check is stopped (its whole process tree), 300 by default, at most 3600 (CLI: `--check-timeout`). Slow suites, such as PHPUnit or a full pytest run, may need more; a result whose check timed out says so with a `note:` line. |
| `temperature` | Temperature for the first attempt. Default 0.6 for Qwen models, sent with Qwen's recommended thinking-mode sampling (`top_p` 0.95, `top_k` 20, `min_p` 0, `presence_penalty` 1.0); the server's own for other models. |
| `retry_temperature_step` | With `check` and `loop: false`: added to the temperature on each retry, capped at 0.8. Default 0.1; 0 keeps it flat. |
| `log_file` | Absolute path. Each attempt's full reply, any apply error, the check output and every tool-loop step (tool call and result) are appended there, for diagnosing a miss. |

`context_files`, `output_file`, and `files` are what save Claude usage: file contents go from disk to WarriorGPT and back without passing through Claude. Claude should still read and check what was written.

With `files`, the model replies with one block per file: the full contents for a new file, or search/replace edits for an existing one, so a small change to a large file costs a few lines instead of a rewrite. The server checks every block before writing anything. Search text that differs from the file only in indentation, trailing spaces or runs of whitespace still matches, and so does search text with the `12: ` line-number prefixes `read_file` shows on every line (they are removed from the replacement too) or, as a last resort, with typographic quotes, dashes and odd spaces where the file has plain ones. The result says which edits matched loosely, and a loose match never counts when it fits more than one place. A search that misses comes back with a hint: the replacement is already in the file (the edit may already be applied), or the closest lines in the file, numbered. A last block missing its `=== END FILE ===` line is accepted. If a block names a file not in `files`, edits a file that does not exist, or has search text that is missing or matches more than one place, nothing is written and the error lists each problem, so Claude can retry with a sharper prompt. Files with Windows line endings keep them.

### Check, racing the tool loop

With `check`, the first attempt is one request with every file attached, as above. By default there is one one-shot attempt — temperature 0.6, `think_budget` (4,096 tokens by default) — raced from the start by a tool-loop lane in its own copy of the tree. The loop lane has no thinking cutoff: its steps run to a 16,384-token output cap, up to `max_steps`. The one-shot reply is applied in its own copy of the working folder and checked there as soon as it arrives. The first lane to pass the check wins and the other is cancelled; the winner's edits are written to the real files and checked once more. If neither passes, the real files are left as they were.

`parallel: n` (at most 6) sends n one-shot attempts at once, as a portfolio of thinking budgets: temperature 0.6 with `think_budget`, 0.3 with three times that, and 0.8 with five times that (20,480 by default), the cycle repeating for attempts 4 to 6; output caps are budget plus `max_tokens`, at most 32,768. An attempt cut off at its budget is reissued with its analysis so far, an order to write its edits, and twice the base budget (8,192, then 16,384 tokens by default, with the output cap raised to leave 8,192 tokens to write); cut off a third time, it is dropped as out of thinking budget. An attempt that spends its output on thinking is dropped at once (no runaway retries in the race). `loop_lane: false` (CLI: `--no-loop-lane`) restores the old order: the one-shot attempts go first, and if none passes the real files get the attempt with the fewest failing tests (the longer thinker breaking ties) and the tool loop starts from it; its first step gets a thinking budget near what the attempts that finished their thinking used, with room to write, until one makes an edit (a step that only reads keeps it). In that order, as soon as every other attempt is out without a pass, the last one still thinking is cut off and told to write its edits now.

The copies skip `.git`, link `node_modules` instead of copying it, and are deleted afterwards; a folder over 5,000 files or 200 MB, one with a linked folder or a broken link, or `files` outside `cwd`, falls back to one attempt. Cancelled attempts' tokens are counted, estimated from what had streamed.

A check in a copy must test the copy. A Python package installed in editable mode would otherwise be imported from the real tree, so every attempt would be checked against the original code. Checks in a copy run with the copy's `src/` (if there is one) and its root first on `PYTHONPATH`, ahead of any value already set. Before the first check, a quick probe (at most 10 seconds, skipped when no task file belongs to a Python package or module) asks Python where each package holding a task file is found, using the check's interpreter if its command starts with one, else a `.venv` or `venv` in the tree, the active virtualenv, or `python3`. It also looks for packages in the tree's top-level `node_modules` that link back into the tree (workspaces, `npm link`) and hold a task file. Either finding is a warning: code imported that way runs the real files, not the edits. The probe cannot see inside a check that builds its own environment (tox, nox, `uv run`, a container).

When the check never passes, the result also looks at why. If every check run failed with the same output (after removing copy paths, timings and object addresses), it warns that the check setup may be wrong rather than the model's code. If an attempt ran out of thinking budget before writing anything, it says that too, since that is the budget, not a wrong answer. Warnings appear as `warning:` lines in the result and the log, and in the CLI's JSON line as `warnings`. A loop that used all its steps, or a check that timed out, adds a `note:` line naming the setting to raise.

The tool loop works through the API's native tool calling, streamed. It gets five tools:

- `read_file`: a file in `cwd` (or an attached file), with line numbers.
- `edit`: one search/replace in a file listed in `files`, with the same matching rules as above. The system prompt lists those files up front, so the model does not try to edit helper files; an edit to any other file is refused.
- `run_check`: runs the check and returns its output. Output over 4,000 characters shows its first 1,500 and last 2,500 characters, and the full output is saved to a temp file named in the result (`[full output: <path>, N lines; read_file it with offset]`), which `read_file` may open until the loop ends. `run_node` output is cut the same way.
- `run_node`: runs a JavaScript snippet as an ES module with the same Node binary that runs the server (`process.execPath`), in `cwd`, with no shell, a 30-second timeout and capped output. It is sandboxed with Node's permission model. It may read the working directory, the attached `context_files`, the original tree (for a copy), and any `node_modules` folders above those (a monorepo's hoisted packages); it may write only inside the working directory, and may not start child processes, workers or addons. A snippet stopped by the sandbox gets those rules back with its output. The model uses it to call the code and see what it really returns.
- `done`: accepted only when the check passes with the latest edits.

If a loop request is over the model's context window (the gateway answers 400 with `context_length_exceeded`), the history is cut hard (every older tool result trimmed, all `reasoning_content` dropped, the latest tool result kept) and the request is sent once more; if it still does not fit, the call stops with an error. A one-shot request over the window stops at once with a usage error (CLI exit 2) suggesting fewer or smaller `context_files`, fewer `files`, or a smaller task.

Several `read_file` and `run_node` calls in one reply run at the same time; edits, checks and `done` run in order. The loop runs until `done` is accepted or `max_steps` runs out (default 30). Older tool outputs are cut down in batches, to keep the history small without breaking the server's cached prompt prefix every step. Each reply's `reasoning_content` goes back on its assistant turn, so the model keeps its earlier analysis between steps; old turns lose it when the history is trimmed. It works with OpenAI-compatible servers that accept the field (vLLM does). If the check never passes, every file is put back byte for byte and any new file is deleted. The result says which attempt or step passed, the lines added and removed, and the tokens used.

`run_node` needs Node 22 or newer: it runs with `--permission`, or `--experimental-permission` before 22.13. The model is told not to write files with the snippets.

With `verify`, once the check passes the model runs a short self-check in the tool loop, up to 8 steps. It rereads the task and the spec, picks the rules the tests skip (edge cases, invalid inputs, exact error messages and values, every case the spec lists), and tests them with `run_node`: import the module, assert many cases in one snippet with `node:assert/strict`, and print each failure with its input, the expected and the actual value. For each failure it rereads the spec text: if its assert contradicts the spec, the assert is wrong, and it fixes the assert and runs it again; it changes the code only when it breaks a rule the spec states, sends every edit that fix needs in one reply, and runs the check in the same reply. When its asserts pass, it calls `done`. In verify mode a `done` before any `run_node` probe is refused once, with an order to test the spec rules first, and on the second-to-last step the model is told to call `done` now.

The self-check never starts a fresh conversation after a race win. When the loop lane won, it continues in the lane's own conversation, which keeps the lane's analysis and the cached prompt; when a one-shot attempt won, it continues that attempt's conversation. Verify steps think without a cutoff and run to the loop lane's 16,384-token output cap.

The result says `verify: passed` (the self-check found nothing to fix), `verify: fixed` (it made N edits, and the check still passes), or `verify: incomplete` (it ran out of steps). When it is incomplete, its edits are kept if the check still passes and undone if it fails: the files go back to how they were when the check passed. An incomplete self-check is still a success: `ok` is true, the files pass the check, and the CLI exits 0. The JSON line and `structuredContent` carry `"verified": true` when the self-check finished and `"verified": false` when it ran out of steps.

Qwen can think for a very long time before writing anything. Two limits keep that in check, client side. A reply still thinking past its thinking budget with nothing written (`think_budget`, 4096 tokens for the first reply; `loop_think_budget`, 1536 for loop steps) is cut off and asked again, with its analysis so far attached and an order to stop analysing and write the edits or call a tool. A reply that used its whole output budget on thinking (finish `length`, or finish `stop` with no edits and thinking above 90% of the limit) is retried the same way. At most two such retries per reply, each with twice the thinking budget of the last (up to 16,384 tokens); they do not count as attempts. The parallel first attempts get one reissue after a budget cut-off and none after a runaway: they are dropped as misses instead. In the tool loop (the loop lane and the verify self-check included), runaway steps do not use up steps (up to six per loop). In the fix loop, each budget cut-off in a row doubles the next step's thinking budget, up to the step's output limit less 1,024 tokens to write the call, until a step calls a tool. A step cut off at the output limit gets its analysis so far back with the nudge, as a budget cut-off does. Retries also send `chat_template_kwargs: {"enable_thinking": false}`; WarriorGPT accepts the field but currently ignores it, and a server that rejects it is detected once and not sent it again.

### Retries without the loop (`loop: false`)

The server writes the model's edits, runs the command, and if it fails sends its output back to the model (the first 1,500 and last 2,500 characters of a long one, so the first traceback is kept) and asks for a fix. The edits stay in place between tries, as an agent's would: the retry shows the model every file as it is now and asks for edits against those current contents, so it fixes what broke instead of redoing the whole change. Only the latest reply is kept in the conversation. If no try passes, every file is put back byte for byte and any new file is deleted, so a failed call leaves the tree as it found it. The result says which attempt passed, the lines added and removed, and the tokens used; each attempt is logged to `usage.jsonl` with an `attempt` field.

The check runs on your machine, in your shell, like any command Claude runs. Claude chooses it, so it is the same trust as Claude's own Bash calls. Keep it fast and focused: the tests for the files in scope, not the whole suite.

A reply that cannot be applied (missing search text, a file outside `files`) or that is cut off at `max_tokens` also counts as a failed attempt, and its error goes back to the model.

### `warriorgpt-ask` CLI

The same call from a shell:

```sh
warriorgpt-ask --prompt-file brief.md --files src/a.js --files test/a.test.js \
  --context src/util.js --check "npm test" --cwd .
```

Flags: `--prompt` or `--prompt-file`, `--files` and `--context` (repeat or comma-separate), `--check`, `--cwd`, `--parallel`, `--no-loop-lane`, `--max-steps`, `--verify`, `--no-loop`, `--max-attempts`, `--check-timeout`, `--log`, `--output-file`, `--model`, `--system-file`, `--max-tokens`, `--loop-max-tokens`, `--think-budget`, `--loop-think-budget`, `--loop-thinking`, `--json`. Relative paths resolve against the current folder. It prints the result, then one JSON line `{ok, attempts, steps?, verified?, files, tokens, warnings?, ms}` (`steps` only when the tool loop ran, `verified` only with `--verify`: true when the self-check finished, false when it ran out of steps; `warnings` only when there are some, see above). Exit codes: 0 passed (or no check), 1 the reply could not be applied (no check), 2 usage error, 3 WarriorGPT unreachable or returned an error, 4 the check never passed and every file was restored. On 4 the JSON line carries `"fallback": "opencode"`, and the MCP tool returns an error with `structuredContent: {ok: false, fallback: "opencode", attempts, steps}`: the task needs an agent that can run the code and read around it, so hand it to OpenCode (`warriorgpt-delegate` or an OpenCode subagent) rather than retrying the same call.

### Background runs

An MCP tool call blocks the Claude session until it returns, and a checked task with retries can take several minutes. For anything with `check` or more than one attempt, have Claude start the CLI with the Bash tool's `run_in_background` instead. Claude keeps working and gets notified when it exits:

```sh
warriorgpt-ask --prompt-file /tmp/brief.md --files src/a.js,test/a.test.js --check "npm test" --cwd "$PWD"
```

Claude then reads the last lines of the output (the summary and the JSON line) and reviews `git diff`. A rule for your `CLAUDE.md`: "For WarriorGPT tasks with a check, run `warriorgpt-ask` with Bash `run_in_background`; use the `ask_warriorgpt` tool only for quick, unchecked calls."

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

Each call appends `{ts, session, model, in, out}` to `usage.jsonl` in the state directory, where `session` is the Claude Code session id. While a request is running, an `active-<session>` file exists there. Runs through `warriorgpt-delegate` append the same record with `via: "opencode"`. A status line script can read both to show WarriorGPT activity and token totals.

The state directory is `~/.local/share/warriorgpt-mcp` on macOS and Linux, and `%LOCALAPPDATA%\warriorgpt-mcp` on Windows.

## Compared with OpenCode

You can also hand WarriorGPT work through an [OpenCode](https://opencode.ai/) subagent, which can search the repo and run code to check itself, but uses some Claude usage per task for the Haiku subagent that briefs and checks it, and is slower. Use `ask_warriorgpt` when you can name the files involved. The npm install includes `warriorgpt-delegate`, a runner for that route: it checks the model answers, runs OpenCode in a git worktree with a minimal config, lets the worker stop and ask questions, and writes a report for the subagent to verify. [docs/opencode-subagent.md](docs/opencode-subagent.md) covers setup, trade-offs, and a benchmark of the two.

## Getting good results

What made jobs pass, from runs on real projects:

- Write the acceptance tests first, and pass them as `check`. With tests that state the behaviour, jobs often pass in under a minute.
- Split a big module into small tasks, each with the exact `files` it may change and the `context_files` it needs. One function or class per call beats one call per feature.
- Review the diff: a passing check is not a review. Passing jobs still shipped sizes in GB labelled as MB, deleted entries while iterating a directory, leaked a file descriptor, copied 17 MB per call for nothing, and failed mypy. Run the linters and type checks the tests do not, and read the code.
- If a result has a `warning:` line, fix that first: retrying the same call will fail the same way.

## Telling Claude when to use it

Claude sees the tool description, but works best with a short rule in your `CLAUDE.md`, for example:

> Use `ask_warriorgpt` for small, fully specified code generation (boilerplate, a straightforward function, tests for existing code). Attach inputs with `context_files`; set `output_file` for one new file, or list every file to create or change in `files`; then read and check the result. Split mixed tasks so the mechanical part still goes to WarriorGPT. Keep design, debugging, and subtle logic with Claude.

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

## Credits

The `warriorgpt-delegate` runner, its worker rules, and the dispatcher version of `warrior-coder` are adapted from a PowerShell setup by [adammpkins](https://github.com/adammpkins).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
