# Delegating through OpenCode instead

This MCP server is the simplest way to let Claude Code hand work to WarriorGPT, but it is not the only one. This guide shows the other route: a Claude Code subagent that runs [OpenCode](https://opencode.ai/) against WarriorGPT, so the WarriorGPT model can read the repo, edit several files, and run commands itself.

It costs more and is slower than `ask_warriorgpt`; see [Compared with OpenCode](../README.md#compared-with-opencode) for the trade-offs and benchmark. The two work side by side: with both set up, Claude can use `ask_warriorgpt` for single-file work and the subagent for the rest.

```
You
 -> Claude Code (plans, decides, verifies)
     -> warrior-coder subagent (Haiku: writes the brief, checks the diff)
         -> opencode run -m warriorgpt/...  (WarriorGPT writes the code)
     <- report + git diff
 <- Claude reviews the diff before calling it done
```

The subagent runs on Haiku, so each delegated task still uses some Claude usage for the brief and the review.

## 1. Install OpenCode

Follow OpenCode's [install docs](https://opencode.ai/docs/). On macOS and Linux that is:

```
curl -fsSL https://opencode.ai/install | bash
```

Check it with `opencode --version`.

## 2. Make the API key available to OpenCode

OpenCode reads the key from the `WARRIORGPT_API_KEY` environment variable only; it does not look in a keychain. Store the key as in [install step 1](../README.md#install) of the README, then:

- **Windows:** nothing more to do; the user environment variable from that step is already set.
- **macOS:** add this to your shell config (`~/.zshrc` or `~/.bashrc`):

  ```
  export WARRIORGPT_API_KEY="$(security find-generic-password -a "$USER" -s warriorgpt-api-key -w 2>/dev/null)"
  ```

- **Linux:** add this to your shell config:

  ```
  export WARRIORGPT_API_KEY="$(secret-tool lookup service warriorgpt-api-key 2>/dev/null)"
  ```

Open a new terminal afterwards, and start Claude Code from a terminal so it inherits the variable.

## 3. Add WarriorGPT to OpenCode

Add this provider to OpenCode's global config file, `~/.config/opencode/opencode.json` on macOS and Linux (see OpenCode's [config docs](https://opencode.ai/docs/config/) for the location on Windows). If the file already exists, merge the `providers.warriorgpt` block into it rather than replacing your settings.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "warriorgpt/local.qwen3.8-27b",
  "providers": {
    "warriorgpt": {
      "name": "WarriorGPT",
      "env": ["WARRIORGPT_API_KEY"],
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": {
        "baseURL": "https://warriorgpt.wayne.edu/api/v1"
      },
      "models": {
        "local.qwen3.8-27b": {
          "name": "Qwen 3.8 27B",
          "capabilities": { "tools": true, "input": ["text", "image"], "output": ["text"] },
          "limit": { "context": 262144, "output": 32768 }
        },
        "local.gpt-oss-120b": {
          "name": "GPT-OSS 120B",
          "capabilities": { "tools": true, "input": ["text"], "output": ["text"] },
          "limit": { "context": 131072, "output": 32768 }
        },
        "local.laguna-s-2.1": {
          "name": "Laguna S 2.1",
          "capabilities": { "tools": true, "input": ["text"], "output": ["text"] },
          "limit": { "context": 131072, "output": 32768 }
        }
      }
    }
  }
}
```

These are OpenCode 2 key names (`providers`, `package`, `settings`). Older OpenCode versions use `provider`, `npm`, and `options` instead.

Test it from a new terminal:

```
opencode run -m warriorgpt/local.qwen3.8-27b "Reply with the single word: ok"
```

A reply of "ok" means the key, config, and gateway all work. A 401 means the key is missing or wrong in this terminal.

## 4. Create the warrior-coder subagent

Save this as `~/.claude/agents/warrior-coder.md` (`%USERPROFILE%\.claude\agents\warrior-coder.md` on Windows), then restart Claude Code. Claude Code runs the subagent's commands in bash (Git Bash on Windows), so the `< /dev/null` and `$CLAUDE_CODE_SESSION_ID` syntax works on every platform.

The agent titles each OpenCode session `[cc:<Claude session id>] <short task>`, which ties it to the Claude session that sent it, for example to find it with `opencode session list` or to total a session's WarriorGPT tokens.

```markdown
---
name: warrior-coder
description: Hands a small, fully specified coding task to opencode running WarriorGPT (Qwen 3.8 27B by default) instead of a Claude model. Best for mechanical edits across a few named files, or tasks where the model should run the code to check its own work. Not for exploring a codebase, debugging, design, or anything needing judgement. Examples: "Add a --dry-run flag to bin/foo.sh and run it to confirm", "Rename X to Y in these three files".
tools: Read, Grep, Glob, Bash
model: haiku
---

You do not write code yourself. You brief opencode, let it make the change, then
check its work and report. The WarriorGPT models are weaker than Claude, so
every brief must be explicit and self-contained.

## Models

Pick one per task:

- `warriorgpt/local.qwen3.8-27b` (262K context): default for writing code.
- `warriorgpt/local.gpt-oss-120b` (131K context): purely mechanical edits
  (renames, boilerplate, repetitive changes).
- `warriorgpt/local.laguna-s-2.1` (131K context): escalation if Qwen's first
  attempt is wrong. It may not be reachable yet; if it hangs or errors, skip it.

## How to work

1. Confirm you are in a git repo and record `git status --short` so you can tell
   opencode's changes apart from ones that were already there.
2. Write the brief. opencode cannot see this conversation, so include:
   - The exact files to read and change, by path.
   - What to change, with any names, signatures, or behavior spelled out.
   - "Match the existing style. Change nothing else. Do not commit."
3. Run it in the foreground from the repo root, with a Bash timeout of about 5
   minutes. Always redirect stdin, or opencode waits on it forever:
   `opencode run -m <model> --title "[cc:$CLAUDE_CODE_SESSION_ID] <short task>" "<brief>" < /dev/null`
   Keep the `[cc:...]` title prefix exactly; it ties the opencode session to the
   Claude session that delegated it.
4. Check the result yourself with `git diff` and by reading the changed files.
   These models make small mistakes (missing newlines, wrong edge cases) and
   report success anyway, so never trust their own summary.
5. If the change is wrong or incomplete, run one follow-up with a sharper brief
   (`opencode run -c ... < /dev/null` continues the session, or switch to Laguna). If it is
   still wrong, stop and report what is off. Do not fix it by hand; the main
   session will take it back.

## Never

- Let opencode commit, push, install packages, or touch files outside the repo.
- Send it secrets, credentials, or files that hold them.
- Hand it a task that needs more than a handful of files in context.

## What to return

- Whether the task is done, partly done, or failed.
- The model used, the files changed with `git diff --stat`, and a one-line
  summary of each change.
- Anything you saw that looks wrong, and anything opencode reported but did not
  actually do.
- If opencode errored (401, 429 rate limit, quota_exceeded, timeout), say so
  plainly; that is a service problem, not a code problem.
```

## 5. Tell Claude when to use which

Add a rule like this to your `CLAUDE.md` (global `~/.claude/CLAUDE.md`, or a project's):

> WarriorGPT is available for small, fully specified coding tasks where a wrong result is easy to spot from the diff. Use `ask_warriorgpt` for a new file or a rewrite of one short file. Use the `warrior-coder` subagent for edits across several files, tasks where the model should run the code to check it, or small changes to large files. Keep design, debugging, review, and subtle logic (security, concurrency, data migrations) with Claude. If WarriorGPT gets the same task wrong twice, do it yourself.

## Try it

In a git repository, start Claude Code and give it a small, concrete task, for example "Have WarriorGPT add a `--dry-run` flag to `bin/deploy.sh` that prints the commands instead of running them." A delegated task usually takes a minute or two. Claude reviews the diff before reporting back.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| 401 / unauthorized | `WARRIORGPT_API_KEY` is empty in the terminal Claude Code was started from. Open a new terminal, check the variable is set, and restart Claude Code. |
| Delegated task hangs with no file changes | `opencode run` is waiting on stdin. Check the agent file runs it with `< /dev/null`. |
| 429 / `quota_exceeded` | WarriorGPT rate limit or quota. Wait and retry, or let Claude do the task itself. |
| Laguna hangs or errors | Laguna S 2.1 may not be reachable on the gateway yet. The subagent should skip it. |
| `warrior-coder` not found | The file is not in `~/.claude/agents/`, or Claude Code was not restarted after creating it. |
| OpenCode rejects the config | Your OpenCode version uses the older key names; see the note under step 3. |
