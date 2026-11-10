#!/usr/bin/env node
// Command-line ask_warriorgpt: the same request, file writing and check loop as the MCP tool, for runs
// Claude starts in the background so a long task does not block the session.
// Exit codes: 0 done (check passed), 1 failed, 2 usage, 3 WarriorGPT unreachable or refused, 4 the check never passed.

import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { ApiError, UsageError, runAsk } from './ask.mjs';
import { setMaxConcurrency } from './limit.mjs';

const HELP = `Usage: warriorgpt-ask (--prompt-file <file> | --prompt <text>) [options]

  --files <path>         a file the model may create or change (repeat, or comma-separate)
  --context <path>       a file attached as context (repeat, or comma-separate)
  --check <command>      with --files: run after the edits; retry with its output until it passes
  --cwd <dir>            where --check runs (default: the project root, the nearest folder above --files with
                         .git, pyproject.toml, package.json, composer.json, go.mod, Cargo.toml, Makefile or a
                         similar marker; else the current folder if it holds the files, else their common folder)
  --parallel <n>         with --check: one-shot attempts at once, each checked in its own copy of the tree,
                         raced by the loop lane from the start; the first to pass wins (default 1, max 6)
  --no-loop-lane         with --check: no racing tool-loop lane; the one-shot attempts go first, then the
                         loop starts from their best (the old behaviour)
  --max-steps <n>        with --check: tool-loop steps (default 30, max 40); raise it when a run ends out of steps
  --verify               with --check: after it passes, the model tests the spec rules the check does not
                         cover with its own node:assert snippets, and fixes genuine failures
  --no-loop              with --check: no tool loop; retry whole replies instead (--max-attempts)
  --max-attempts <n>     with --no-loop: attempts before giving up (default 3, max 5)
  --check-timeout <s>    with --check: seconds before a run is killed (default 300, max 3600); slow suites
                         (PHP, a full pytest run) may need more
  --output-file <path>   write the reply to this one file instead (not with --files)
  --model <id>           WarriorGPT model (default local.qwen3.8-27b or WARRIORGPT_MODEL)
  --system-file <file>   a system prompt
  --max-tokens <n>       max output tokens for the first reply (default 16384)
  --loop-max-tokens <n>  max output tokens per tool-loop or verify step (default 8192)
  --think-budget <n>     edit tasks: cut a reply off once its thinking passes n tokens with nothing written,
                         then ask for the edits with the analysis so far, doubling the budget on each retry
                         up to 16384 (default 4096; 0 = no budget)
  --loop-think-budget <n> the same for tool-loop and verify steps (default 1536)
  --loop-thinking <mode> auto|on|off: ask the server to skip thinking in loop steps (auto: after a runaway)
  --temperature <t>      temperature for the first attempt (default 0.6 with Qwen's top_p/top_k/presence
                         penalty for Qwen models; the server's own for others)
  --retry-temperature-step <t>  added per retry, capped at 0.8 (default 0.1; 0 keeps it flat)
  --log <file>           append every reply and check output to this file
  --max-concurrency <n>  WarriorGPT requests in flight at once, shared with every other warriorgpt-ask and
                         warriorgpt-mcp on this machine (default 6 or WARRIORGPT_MAX_CONCURRENCY; 0 = no limit)
  --json                 print only the final JSON line

With --check, the first attempt is one request with every file attached. If its check fails, the model gets
tools (read_file, edit, run_check, run_node: a JavaScript snippet run with this Node, no shell) and works
until the check passes or the steps run out. If it never passes, every file is restored.

Prints a short digest, then one JSON line: {ok, attempts, steps?, verified?, files, tokens, warnings?, ms} (plus
fallback when --check never passed). warnings: problems that are probably not the model's code, such as a check
that tests the real tree instead of the copy, or one that fails the same way whatever the edits.

Jobs pass fastest when the acceptance tests are written first and passed as --check, and a big change is split
into small tasks, each naming its --files and --context. Review the diff: a passing check is not a review. verified is false when the --verify self-check did not finish; the files still pass
the check (self-check edits that broke it are undone).
Exit codes: 0 done (check passed); 1 failed (a reply that could not be applied, no --check); 2 usage, including a
check whose program cannot run from --cwd;
3 WarriorGPT unreachable or refused; 4 --check never passed, every file restored: hand the task to an agent
that can run the code, such as OpenCode.`;

const list = (values) => (values || []).flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);

async function main() {
    let opts;
    try {
        ({ values: opts } = parseArgs({
            options: {
                prompt: { type: 'string' },
                'prompt-file': { type: 'string' },
                files: { type: 'string', multiple: true },
                context: { type: 'string', multiple: true },
                check: { type: 'string' },
                cwd: { type: 'string' },
                'max-attempts': { type: 'string' },
                'max-steps': { type: 'string' },
                parallel: { type: 'string' },
                verify: { type: 'boolean' },
                'no-loop': { type: 'boolean' },
                'no-loop-lane': { type: 'boolean' },
                'check-timeout': { type: 'string' },
                'output-file': { type: 'string' },
                model: { type: 'string' },
                'system-file': { type: 'string' },
                'max-tokens': { type: 'string' },
                'loop-max-tokens': { type: 'string' },
                'think-budget': { type: 'string' },
                'loop-think-budget': { type: 'string' },
                'loop-thinking': { type: 'string' },
                temperature: { type: 'string' },
                'retry-temperature-step': { type: 'string' },
                log: { type: 'string' },
                'max-concurrency': { type: 'string' },
                json: { type: 'boolean' },
                help: { type: 'boolean', short: 'h' },
            },
        }));
    } catch (err) {
        throw new UsageError(err.message);
    }
    if (opts.help) {
        console.log(HELP);
        return 0;
    }
    const read = (path, what) => {
        try {
            return readFileSync(path, 'utf8');
        } catch {
            throw new UsageError(`cannot read ${what} ${path}`);
        }
    };
    const prompt = opts['prompt-file'] ? read(opts['prompt-file'], '--prompt-file') : opts.prompt;
    if (!prompt) throw new UsageError('--prompt-file or --prompt is required (see --help).');
    if (opts['max-concurrency'] !== undefined) {
        try {
            setMaxConcurrency(opts['max-concurrency']);
        } catch (err) {
            throw new UsageError(`--max-concurrency: ${err.message}`);
        }
    }

    const started = Date.now();
    const res = await runAsk({
        prompt,
        files: list(opts.files),
        context_files: list(opts.context),
        check: opts.check,
        cwd: opts.cwd,
        max_attempts: opts['max-attempts'],
        max_steps: opts['max-steps'],
        parallel: opts.parallel,
        verify: !!opts.verify,
        loop: !opts['no-loop'],
        loop_lane: !opts['no-loop-lane'],
        check_timeout_s: opts['check-timeout'],
        output_file: opts['output-file'],
        model: opts.model,
        system: opts['system-file'] ? read(opts['system-file'], '--system-file') : undefined,
        max_tokens: opts['max-tokens'] ? Number(opts['max-tokens']) : undefined,
        loop_max_tokens: opts['loop-max-tokens'],
        think_budget: opts['think-budget'],
        loop_think_budget: opts['loop-think-budget'],
        loop_thinking: opts['loop-thinking'],
        log_file: opts.log,
        temperature: opts.temperature,
        retry_temperature_step: opts['retry-temperature-step'],
    });
    if (!opts.json) console.log(res.text);
    console.log(JSON.stringify({ ok: res.ok, attempts: res.attempts, ...(res.steps ? { steps: res.steps } : {}),
        ...(res.verified !== undefined ? { verified: res.verified } : {}), files: res.files, tokens: res.usage,
        ...(res.fallback ? { fallback: res.fallback } : {}), ...(res.warnings ? { warnings: res.warnings } : {}), ms: Date.now() - started }));
    return !res.ok ? 4 : 0;
}

main().then((code) => {
    process.exitCode = code;
}, (err) => {
    const code = err instanceof UsageError ? 2 : err instanceof ApiError ? 3 : 1;
    console.error(`warriorgpt-ask: ${err.message}`);
    console.log(JSON.stringify({ ok: false, error: err.message, code }));
    process.exitCode = code;
});
