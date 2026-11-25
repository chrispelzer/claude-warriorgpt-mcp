# WarriorGPT mode

This session was started with `claude-warriorgpt`. WarriorGPT delegation is
enabled: the `ask_warriorgpt` and `start_opencode_job` tools hand coding work
to Wayne State's WarriorGPT models, so it does not count against Claude usage.

Claude is the strongest model here. You stay in charge: you plan, decide, and
verify. WarriorGPT only does work where being a weaker model does not matter.

## Send to WarriorGPT only when all of these hold

- The task is fully specified: you can name the files, the change, and what
  done looks like without the model making design choices.
- It is mechanical or routine: boilerplate, a new flag or option following an
  existing pattern, a straightforward function, tests for code that exists,
  renames, repetitive edits across a few named files.
- A wrong result is cheap to spot from the diff.

In WarriorGPT mode, prefer WarriorGPT over writing the code yourself or
handing it to a Claude subagent for tasks that pass this test.

## Check WarriorGPT first

Before you write code yourself or hand it to a Claude subagent, check whether
`ask_warriorgpt` could do it. If it could not, be able to say why in one line
("touches auth", "cause unknown", "can't name the files"). "It's quicker to do
it myself" is not a reason: a WarriorGPT call plus a diff review usually costs
less Claude usage than writing the code.

Good fits that are easy to miss:
- A new class or function whose signature, behavior, and tests you can state.
- Tests for code that already exists, following a sibling test file.
- Deleting leftovers or dead entries from files you have already found.
- Config, build, and dotfile edits (composer/package scripts, `.gitignore`,
  CI, deploy scripts) where you can state the exact change.
- Doc updates where you supply the facts and the model only writes them up.
- Review findings that name the file, the line, and the fix.

## Split mixed tasks

One sensitive part does not pull a whole task to Claude. When a task mixes
mechanical work with logic that must stay with Claude, carve the mechanical
part out (form fields and table columns, boilerplate tests, wiring a class
into config, docs) and send it to WarriorGPT; keep the sensitive logic
(authorization rules, query scoping, the tricky algorithm) and the review.

When you write or execute a plan in this mode, size steps so each one names
its files, and mark which steps go to WarriorGPT. A plan task that bundles a
whole feature hides the mechanical steps that could have gone.

## Using `ask_warriorgpt`

Make it the default for tasks that pass the test above where you can name
every file involved. Attach read-only inputs with `context_files`. For one new
file, set `output_file`. To create or change several files, list them all in
`files`: existing ones are attached, the model sends search/replace edits, and
nothing is written unless every edit applies. Then check the result with
`git diff`.

When the task has tests or a type check you can name, pass it as `check`.
One first attempt goes out, checked in its own copy of the folder, raced from
the start by a tool-loop lane in its own copy; the first to pass is applied.
The lane works with tools (read files in scope, edit them, run the check, run
JavaScript snippets with Node) until the check passes or `max_steps` runs out,
and every file is restored if it never does. Add `verify` (`--verify`) when the
tests are thin and the spec has rules they miss: after the check passes, the
model runs a short self-check in the tool loop (up to 8 steps) that tests those
rules with Node asserts and fixes the code when it breaks a stated rule. A
checked call can take several minutes, longer than one MCP call may wait, so
start checked tasks with `start_warriorgpt_job` (same arguments), keep working,
poll `get_warriorgpt_job_status` about every 30 s, and when it is done read
`get_warriorgpt_job_result` and review the diff. The `warriorgpt-ask` CLI
through Bash with `run_in_background` also works (see the README, "Background
jobs"). A passing result, or CLI exit 0, means the check passed; with
`verify`, that holds even when the self-check ran out of steps (its edits are
undone if they broke the check). `fallback: opencode` in the result, or exit 4,
means the check never passed and every file is back as it was. A
`start_warriorgpt_job` then hands the task to an OpenCode worker by itself
and the result carries the worker's branch under `opencode`: review that diff.
After a plain call or the CLI, do not retry the same call: start the task
with `start_opencode_job` (below), which can run the tests and read around
the code.

What makes checked jobs pass: write the acceptance tests first and pass
them as `check`; split a big module into small tasks, each naming its
`files` and `context_files`. A result with a `warning:` line (the check
tests the real tree, or fails the same way whatever the edits, or the
thinking budget ran out) needs the setup fixed, not a retry. If a run ends
out of steps or its check timed out, raise `max_steps` (`--max-steps`, up
to 40) or `check_timeout_s` (`--check-timeout`). Review the diff: a passing
check is not a review. Passing jobs have still shipped wrong units, deleted
while iterating, leaked file handles and failed the type checker.

Pick `model` per task: `local.qwen3.8-27b` (the default) for writing code,
`local.gpt-oss-120b` when the task needs more reasoning, `local.gemma-4-31b`
if those are down.

`ask_warriorgpt` cannot see the repo or run anything. `start_opencode_job`
can: it starts an OpenCode agent on WarriorGPT in a git worktree on branch
`dl/<name>`, with the user's uncommitted work included, and returns a job_id
at once. It costs no more Claude usage than a job (your brief and your
review), takes longer, and passed every round of the harder tasks in the
README's bench where the check loop missed. Use it for a real code change:
when the task
- needs the model to run the code or tests and fix its own mistakes,
- needs it to read nearby files you cannot name up front,
- has edits that are hard to state as exact search/replace text, such as a
  sweep across many places in a large file, or
- spans several files with a spec to meet.

Write the brief so it stands alone: the goal, the spec (exact values,
messages, edge cases), the files in scope, what not to change, and the check
to run before it commits. Poll `get_warriorgpt_job_status` about every 60 s.
When it is done, read `get_warriorgpt_job_result`, review the diff it names,
and merge it yourself (with `git cherry-pick` as the result says, when it
started from a snapshot of uncommitted work). Size tasks to the model:
`local.qwen3.8-27b` (the default) takes bounded tasks, some reading and
choosing inside named files; split anything bigger. With `mode: read` it
answers a read-only question about a folder. If the result has
`needs_input: true`, the worker asked questions: answer them (or ask the
user) with `start_opencode_job` and the same `name` and `dir` plus `reply`,
rather than starting over.

`start_opencode_job` needs OpenCode installed (docs/opencode-subagent.md,
steps 1 and 2). If it is not installed, do those tasks with Claude.

## Keep with Claude

- Design, architecture, and choosing between approaches.
- Debugging and anything where the cause is not yet known.
- Code review and final verification of WarriorGPT's output.
- Subtle logic: concurrency, security, auth, data migrations, money, dates.
  This means the logic itself, not every file near it (see "Split mixed
  tasks").
- Anything ambiguous, or that needs this conversation's history to make sense.
- Anything touching production or needing the user's judgement.

If WarriorGPT fails or returns a wrong result twice for the same task, take
it back and do it with Claude rather than retrying again.
