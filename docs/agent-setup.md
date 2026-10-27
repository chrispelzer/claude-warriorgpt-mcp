# Setup instructions for Claude Code

You are installing the `ask_warriorgpt` MCP server for the user. The exact commands are in the [README](../README.md) (https://github.com/chrispelzer/claude-warriorgpt-mcp#readme); read it first and use its commands for this platform. Follow the steps in order. Steps marked "User" need the person at the keyboard: tell them exactly what to run and wait.

## Rules

- Check before changing anything. If a step is already done, say so and skip it.
- Never ask for the API key in the chat, never print it, and never write it to a file or pass it to `claude mcp add`.
- Before editing a shell config or profile, show the user the line you will add.
- Detect the platform with `uname` (macOS: Darwin, Linux: Linux) or `$env:OS` in PowerShell (Windows).

## Steps

1. **Prerequisites.** Check `claude --version` and `node --version` (18 or newer). If Node is missing or too old, stop and tell the user.

2. **API key [User].** Check whether a key is already stored:
   - macOS: `security find-generic-password -a "$USER" -s warriorgpt-api-key >/dev/null 2>&1 && echo found`
   - Linux: `secret-tool lookup service warriorgpt-api-key >/dev/null 2>&1 && echo found`
   - Windows: `[Environment]::GetEnvironmentVariable('WARRIORGPT_API_KEY', 'User')` is not empty

   If not found, ask the user to create a key at https://warriorgpt.wayne.edu/developer/api-key and run the README's install step 1 command in their own terminal. Recheck when they say it is done.

3. **Install.** Run the README's install step 2. Confirm with `command -v warriorgpt-mcp` (`where warriorgpt-mcp` on Windows).

4. **Register.** If `claude mcp list` already shows `warriorgpt`, skip this. Otherwise run the README's install step 3 for this platform.

5. **WarriorGPT mode [optional].** Ask the user whether they want delegation in every session or only when they choose.
   - Every session: add the README's example rule to `~/.claude/CLAUDE.md`, unless a similar rule is there already.
   - Only when they choose: follow the README's "claude-warriorgpt alias" steps. If `~/.claude/warriorgpt-mode.md` already exists, show the user the diff against the packaged copy and ask before overwriting it. Skip the alias if their shell config already defines `claude-warriorgpt`.

6. **Finish [User].** Tell the user to open a new terminal, start Claude Code (or `claude-warriorgpt`), and check `/mcp` shows `warriorgpt` as connected. If it fails, use the README's troubleshooting table.
