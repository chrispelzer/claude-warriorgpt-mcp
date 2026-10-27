# Delegating through OpenCode instead

This MCP server is the simplest way to let Claude Code hand work to WarriorGPT, but it is not the only one. This guide shows the other route: a Claude Code subagent that runs [OpenCode](https://opencode.ai/) against WarriorGPT, so the WarriorGPT model can search the repo, edit files, and run commands itself.

It uses more Claude usage (a Haiku subagent per task) and is slower than `ask_warriorgpt`; see [Compared with ask_warriorgpt](#compared-with-ask_warriorgpt) for the trade-offs and benchmark. The two work side by side: with both set up, Claude can use `ask_warriorgpt` when it can name the files and the subagent for the rest.

```
You
 -> Claude Code (plans, decides, verifies)
     -> warrior-coder subagent (Haiku: writes the brief, relays questions, checks the diff)
         -> warriorgpt-delegate (checks the model, makes a worktree, minimal OpenCode config)
             -> opencode run -m warriorgpt/...  (WarriorGPT writes the code and commits on dl/<name>)
     <- report + git diff
 <- Claude reviews the diff before calling it done
```

The subagent runs on Haiku, so each delegated task still uses some Claude usage for the brief and the review.

## Compared with ask_warriorgpt

Both routes have WarriorGPT write the code. `ask_warriorgpt` adds no Claude usage beyond the main thread's own request and review, and is faster, and with `files` it can create and edit several named files, but it cannot search the repo or run anything. OpenCode can find files itself and run code to check its own work, at the cost of a Haiku subagent that briefs and checks each task. WarriorGPT tokens do not count against your Claude plan, so the OpenCode route's much larger WarriorGPT token counts below cost only time. Use `ask_warriorgpt` when you can name the files involved, and the subagent when the model needs to explore the repo or test its own work.

The benchmark below was run on 2026-10-27 with `local.qwen3.8-27b`, with `warrior-coder` going through the `warriorgpt-delegate` runner. Each route got the same three tasks in a fresh git repo, once each and one run at a time, and the results were checked against tests the model never saw.

| Task | Route | Extra Claude tokens (subagent) | Wall time | WarriorGPT tokens (in / out) | Tests |
|---|---|---|---|---|---|
| Write a new `slugify.py` | `ask_warriorgpt` | none | 11s | 175 / 1,210 | Pass |
| Write a new `slugify.py` | `warrior-coder` | 15.0k Haiku | 58s (38s in OpenCode) | 100,237 / 3,374 | Pass |
| Write a new `slugify.py` | Claude only (`code-writer`) | 10.3k Sonnet | 9s | none | Pass |
| Add a `-a` flag to a shell script | `ask_warriorgpt` | none | 17s | 324 / 1,898 | Pass |
| Add a `-a` flag to a shell script | `warrior-coder` | 16.6k Haiku | 48s (22s in OpenCode) | 35,220 / 2,009 | Pass |
| Add a `-a` flag to a shell script | Claude only (`code-writer`) | 11.0k Sonnet | 14s | none | Pass |
| Add `f_to_c` across 4 files (module, `__init__`, CLI, tests) | `ask_warriorgpt` with `files` | none | 9s | 1,183 / 1,431 | Pass |
| Add `f_to_c` across 4 files (module, `__init__`, CLI, tests) | `warrior-coder` | 16.0k Haiku | 36s (16s in OpenCode) | 52,460 / 1,904 | Pass |
| Add `f_to_c` across 4 files (module, `__init__`, CLI, tests) | Claude only (`code-writer`) | 11.1k Sonnet | 12s | none | Pass |

For comparison, the Claude-only rows hand the same tasks to a Sonnet `code-writer` subagent, with no WarriorGPT involved. It used fewer tokens than `warrior-coder`, but by API price a Sonnet 5.5 token costs 20 times a Haiku 5.5 token ($2 vs $0.10 per million input), so it used roughly 13 times as much Claude usage per task. Plan limits are not published per token, so API price is a guide, not an exact ratio. The three Claude-only runs ran at the same time, not one after another.

Claude tokens are what count against your plan. The extra column is the `warrior-coder` subagent's Haiku tokens for writing the brief, running the runner, and checking the diff; `ask_warriorgpt` starts no subagent. Both routes also cost the main thread the same on top: a few hundred tokens to write the request, plus its review of the diff. Those come from your main model, which uses your plan faster per token than Haiku. Output tokens include reasoning. Both routes wrote nearly the same code, and in every `warrior-coder` run the worker tested and committed its own change and the dispatcher reran the checks. Caveats: one run per cell, and run-to-run variance is large (the same `warrior-coder` tasks in an earlier run took 35k to 121k WarriorGPT input tokens and up to 90 seconds). The Claude column was measured with a Haiku agent given the `warrior-coder` instructions and nearly the same tools, because the session running the benchmark had the old agent loaded.

## 1. Install OpenCode

Follow OpenCode's [install docs](https://opencode.ai/docs/). On macOS and Linux that is:

```
curl -fsSL https://opencode.ai/install | bash
```

Check it with `opencode --version`.

## 2. Make the API key available to OpenCode

OpenCode reads the key from the `WARRIORGPT_API_KEY` environment variable only; it does not look in a keychain. The `warriorgpt-delegate` runner (step 4) reads the keychain itself and passes the key on, so this step only matters for running `opencode` directly, as in the test below. Store the key as in [install step 1](../README.md#install) of the README, then:

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
        },
        "local.gemma-4-31b": {
          "name": "Gemma 4 31B (vision, no tools)",
          "capabilities": { "tools": false, "input": ["text", "image"], "output": ["text"] },
          "limit": { "context": 131072, "output": 32768 }
        }
      }
    }
  }
}
```

Gemma has no tool calling, so OpenCode can use it for chat but not to edit files; the subagent below does not use it.

These are OpenCode 2 key names (`providers`, `package`, `settings`). Older OpenCode versions use `provider`, `npm`, and `options` instead.

Test it from a new terminal:

```
opencode run -m warriorgpt/local.qwen3.8-27b "Reply with the single word: ok"
```

A reply of "ok" means the key, config, and gateway all work. A 401 means the key is missing or wrong in this terminal.

## 4. Check the runner

The npm install also puts `warriorgpt-delegate` on your PATH. It hands one task to OpenCode and collects the evidence the subagent checks. It needs OpenCode 2 or newer. Check that it can reach the model:

```
warriorgpt-delegate --probe
```

What it does on each run:

- **Checks the model first.** A model that does not answer (Laguna, for now) exits 3 straight away instead of hanging.
- **Keeps the worker off your checkout.** In write mode in a git repo it creates a worktree on branch `dl/<name>` from `--base` (default `HEAD`) and the worker commits there. Uncommitted changes in your checkout are not in the worktree. Outside git it works in the folder itself and lists every file added, changed, or deleted.
- **Gives OpenCode a minimal config.** It takes your `warriorgpt` provider block from `~/.config/opencode/opencode.json` and nothing else: no plugins, MCP servers, skills, `AGENTS.md`, or `CLAUDE.md`. The worker's instructions are the packaged [`delegate/WORKER_RULES.md`](../delegate/WORKER_RULES.md) plus any `--instructions` files. This shrinks every request and keeps your personal setup out of the worker's context.
- **Uses two OpenCode agents.** `delegate-worker` writes; `delegate-reader` (`--mode read`) answers questions and cannot edit files or run destructive commands. Both have OpenCode's question tool turned off, because an unattended run would hang on it. These permissions limit OpenCode's tools; they are not a sandbox, and a shell command can still reach outside the folder.
- **Lets the worker ask questions.** A worker that hits a question that changes the result stops with `STATUS: NEEDS_INPUT` and numbered questions, each with a default. Rerun with `--continue --resume` and a brief holding the answers, and it continues the same OpenCode session, keeping everything it already read.
- **Writes a run folder** under `~/.local/share/warriorgpt-mcp/runs/<project>/<name>` (`%LOCALAPPDATA%\warriorgpt-mcp\runs\...` on Windows) with the brief, the OpenCode event log, `report.md`, and `summary.json`, and logs tokens to the same `usage.jsonl` as `ask_warriorgpt`.
- **Never merges, pushes, or deletes.**

Exit codes: 0 done; 1 failed; 2 usage error; 3 model unreachable; 4 the worker asked questions; 8 timed out; 9 write mode made no change; 10 the worker reported PARTIAL or BLOCKED, or no STATUS. `warriorgpt-delegate --help` lists the options.

To bring finished work into your branch, then clean up:

```
git merge dl/<name>
git worktree remove <worktree path from the report>
git branch -d dl/<name>
```

## 5. Create the warrior-coder subagent

Save this as `~/.claude/agents/warrior-coder.md` (`%USERPROFILE%\.claude\agents\warrior-coder.md` on Windows), then restart Claude Code. Claude Code runs the subagent's commands in bash (Git Bash on Windows), so the same commands work on every platform.

The subagent is a dispatcher: it writes the brief, starts the runner, relays the worker's questions, and checks the result against the diff. It never writes project code itself.

```markdown
---
name: warrior-coder
description: Hands a small, fully specified coding or research task to OpenCode running WarriorGPT (Qwen 3.8 27B by default) through warriorgpt-delegate, then checks the result. Best for mechanical edits across a few named files, tasks where the model should run the code to check its own work, or a read-only question about one folder. Not for design, debugging, or anything needing judgement. Examples: "Add a --dry-run flag to bin/foo.sh and run it to confirm", "Rename X to Y in these three files", "Which functions in src/date/ handle time zones?".
tools: Read, Grep, Glob, Bash, Write
model: haiku
---

You are a dispatcher and checker. A WarriorGPT model does the work through
OpenCode; you start it, relay its questions, verify what it claims, and report.
You never write project code and never fix the worker's output.

## Input from the lead

A task name (lower-case, dashes); a brief that stands alone (goal, files in
scope, files to read first, acceptance checks); the project folder; the mode,
`write` (default) or `read`. If the brief is missing the scope or the
acceptance checks, return at once and say what is missing.

## Models and task size

Return a task that is too big for the model, unrun, with the split you suggest.

- `local.qwen3.8-27b` (default): bounded tasks, some reading and choosing
  inside named files (a test file from a fixed interface, a small function, a
  script with its self-test, a question about one package).
- `local.gpt-oss-120b`: atomic tasks only: one file, one change, the exact text
  to replace and its replacement given, one check command. On multi-step
  tasks it has skipped commits, deleted checks, and reported work it had not done.
- Anything larger goes back to the lead to be split.

## Method

1. Write the brief with the Write tool to a file in your scratchpad directory
   (or the system temp folder). Brief files are the only files you write.
2. Run it with Bash in the background (`run_in_background: true`) and wait for
   the completion notice; do not poll:
   `warriorgpt-delegate --name <name> --brief <file> --dir <project> [--mode read] [--model <id>] [--timeout <minutes>]`
3. Read the report it prints (also `report.md` and `summary.json` in the run
   folder it names). On exit 3, stop and report the model as unreachable.
4. Exit 4 means the worker asked questions. If the brief answers one word for
   word, answer it yourself, quoting the brief. Otherwise return the questions
   verbatim to the lead, each with the worker's default, and wait to be
   continued. Write the answers to a new brief file and rerun step 2 with the
   same name plus `--continue --resume`. At most three rounds.
5. Verify; the worker's handoff is a claim, not evidence.
   - Write mode in git: in the worktree from the report, run
     `git log --oneline <base_sha>..HEAD`, `git diff <base_sha>..HEAD`, and
     `git status --short`. Read every deleted line and list any behavior removed.
     Every changed file must be in the brief's scope. A claimed change that is
     not in the diff is a failure to report.
   - Write mode outside git: read every file in `changed`; put anything DELETED
     or out of scope at the top of your report.
   - Read mode: spot-check at least three cited `path:line` claims and mark
     each CONFIRMED or WRONG. A non-empty `changed` list is a violation.
   - Run the brief's acceptance checks yourself when they are quick, and mark
     the worker's own checks as "claimed".
6. When a check fails and the fix is clear, write the exact failure to a new
   brief and rerun with `--continue` (add `--resume` if the worker's context
   still helps). At most two follow-ups. Never tell the worker to loosen a test.

## Never

- Merge, rebase, reset, push, or delete branches or worktrees.
- Edit project files, or send secrets or files that hold them.

## What to return

1. Outcome in one line: DONE / PARTIAL / BLOCKED / NEEDS INPUT / UNREACHABLE,
   and the model used.
2. What changed (from your reading of the diff), or the research answer with
   CONFIRMED/WRONG marks.
3. Where: branch `dl/<name>` and its worktree, or the folder, and the run folder.
4. Checks you ran with results; the worker's checks marked as claimed.
5. Scope violations, removed behavior, unverified parts.
6. What the lead must still do (review, merge, clean up), and any questions.
```

## 6. Tell Claude when to use which

Add a rule like this to your `CLAUDE.md` (global `~/.claude/CLAUDE.md`, or a project's):

> WarriorGPT is available for small, fully specified coding tasks where a wrong result is easy to spot from the diff. Use `ask_warriorgpt` when you can name every file to create or change. Use the `warrior-coder` subagent when the model needs to find files itself or run the code to check it. Keep design, debugging, review, and subtle logic (security, concurrency, data migrations) with Claude. Split mixed tasks so the mechanical part still goes to WarriorGPT. If WarriorGPT gets the same task wrong twice, do it yourself.

## Try it

In a git repository, start Claude Code and give it a small, concrete task, for example "Have WarriorGPT add a `--dry-run` flag to `bin/deploy.sh` that prints the commands instead of running them." A delegated task usually takes a minute or two. Claude reviews the diff before reporting back.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| 401 / unauthorized | `WARRIORGPT_API_KEY` is empty in the terminal Claude Code was started from. Open a new terminal, check the variable is set, and restart Claude Code. |
| `warriorgpt-delegate` exits 3 | The model does not answer. Try another `--model`; check `warriorgpt-delegate --probe`. |
| `warriorgpt-delegate` exits 1 with an `opencode` error | Check `opencode --version` is 2 or newer, and look at the `stderr` log in the run folder. |
| "branch dl/<name> already exists" | An earlier run used that name. Merge or delete it (step 4), or pick another `--name`. |
| 429 / `quota_exceeded` | WarriorGPT rate limit or quota. Wait and retry, or let Claude do the task itself. |
| Laguna errors | Laguna S 2.1 is not reachable on the gateway yet (it returns 500). The runner exits 3 for it. |
| `warrior-coder` not found | The file is not in `~/.claude/agents/`, or Claude Code was not restarted after creating it. |
| OpenCode rejects the config | Your OpenCode version uses the older key names; see the note under step 3. |
