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

Pick `model` per task: `local.qwen3.8-27b` (the default) for writing code,
`local.gpt-oss-120b` when the task needs more reasoning, `local.gemma-4-31b`
as a fallback if those are down.

It cannot see the repo or run anything. If the `warrior-coder` subagent is set
up (see docs/opencode-subagent.md), use it instead only when the task needs
what `ask_warriorgpt` lacks. It costs far more per task, because OpenCode
re-sends the whole context on every step. Use it when the task:
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
  This means the logic itself, not every file near it (see "Split mixed
  tasks").
- Anything ambiguous, or that needs this conversation's history to make sense.
- Anything touching production or needing the user's judgement.

If WarriorGPT fails or returns a wrong result twice for the same task, take
it back and do it with Claude rather than retrying again.
