# WarriorGPT mode

This session was started with `claude-warriorgpt`. WarriorGPT delegation is
enabled: the `ask_warriorgpt` tool hands coding work to Wayne State's
WarriorGPT models, so it does not count against Claude usage.

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

## Using `ask_warriorgpt`

Make it the default for tasks that pass the test above where you can name
every file involved. Attach read-only inputs with `context_files`. For one new
file, set `output_file`. To create or change several files, list them all in
`files`: existing ones are attached, the model sends search/replace edits, and
nothing is written unless every edit applies. Then check the result with
`git diff`.

Pick `model` per task: `local.qwen3.8-27b` (the default) for writing code,
`local.gpt-oss-120b` when the task needs more reasoning, `local.gemma-4-31b`
as a fallback if those are down.

It cannot see the repo or run anything. If the `warrior-coder` subagent is set
up (see docs/opencode-subagent.md), use it instead when the task:
- needs the model to run the code or tests and fix its own mistakes,
- needs it to read nearby files you cannot name up front, or
- has edits that are hard to state as exact search/replace text, such as a
  sweep across many places in a large file.

Without `warrior-coder`, do those tasks with Claude.

## Keep with Claude

- Design, architecture, and choosing between approaches.
- Debugging and anything where the cause is not yet known.
- Code review and final verification of WarriorGPT's output.
- Subtle logic: concurrency, security, auth, data migrations, money, dates.
- Anything ambiguous, or that needs this conversation's history to make sense.
- Anything touching production or needing the user's judgement.

If WarriorGPT fails or returns a wrong result twice for the same task, take
it back and do it with Claude rather than retrying again.
