#!/usr/bin/env node
// MCP server (stdio) exposing WarriorGPT's OpenAI-compatible chat API as a tool, so a Claude Code
// session can hand text generation to WarriorGPT without going through opencode.

import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { DEFAULT_MODEL } from './common.mjs';
import { MODELS, runAsk, UsageError } from './ask.mjs';
import { createJobs, track } from './jobs.mjs';
import { setMaxConcurrency } from './limit.mjs';

const TOOL = {
    name: 'ask_warriorgpt',
    description:
        'Send a prompt to a WarriorGPT model (Wayne State, free) and get its text reply. Give it everything it ' +
        'needs: use context_files to attach files, and output_file (one file) or files (several new or existing ' +
        'files, edited in place) to write the reply straight to disk, so the content never passes through Claude. ' +
        'With files, check runs a command after the edits (tests, a type check). If the first one-shot attempt ' +
        'misses, the model gets tools (read_file, edit, run_check, and run_node, which runs a JavaScript snippet ' +
        'with this Node and no shell) and works until the check passes or max_steps runs out. By default a ' +
        'tool-loop lane races the one-shot attempts from the start, each attempt checked in its own copy of ' +
        'the tree. verify adds a ' +
        'round of the model\'s own spec checks after the check passes. If the check never passes, every file is ' +
        'restored and the result says fallback: opencode, meaning hand the task to a full coding agent. ' +
        'With verify, structuredContent carries verified: true when the self-check finished, false when it ran out ' +
        'of steps; either way the files pass the check. ' +
        'This call blocks until it finishes, and a checked task runs for minutes, longer than a tool call may wait: ' +
        'for anything with check, use start_warriorgpt_job instead (same arguments) and poll it. Use this tool ' +
        'for quick calls without check. Jobs pass fastest with the acceptance tests written first and ' +
        'passed as check, and with a big change split into small tasks that each name their files and context_files. ' +
        'A "warning:" line in the result means the problem is probably not the model\'s code (the check tests the ' +
        'real tree instead of the copy, fails the same way whatever the edits, or the thinking budget ran out). ' +
        'Review the diff: a passing check is not a review.',
    inputSchema: {
        type: 'object',
        properties: {
            prompt: { type: 'string', description: 'The task or question.' },
            model: {
                type: 'string',
                description: `WarriorGPT model id. Default ${DEFAULT_MODEL}. Known models:\n` +
                    Object.entries(MODELS).map(([id, d]) => `- ${id}: ${d}`).join('\n'),
            },
            system: { type: 'string', description: 'Optional system prompt.' },
            context_files: {
                type: 'array',
                items: { type: 'string' },
                description: 'Absolute paths of files to include as context.',
            },
            output_file: {
                type: 'string',
                description: 'Absolute path. If set, the model is asked for only the file contents, which are ' +
                    'written here (overwriting), and the tool returns a short summary instead of the text.',
            },
            files: {
                type: 'array',
                items: { type: 'string' },
                description: 'Absolute paths the model may create or change; existing ones are attached ' +
                    'automatically. It replies with a full body for new files and search/replace edits for ' +
                    'existing ones. Every block is checked first: if any fails, nothing is written. ' +
                    'Not with output_file.',
            },
            check: {
                type: 'string',
                description: 'With files: a shell command run after the edits are written, such as the tests that ' +
                    'should pass. On failure the tool loop starts (or, with loop: false, the model retries with the ' +
                    'output); if it never passes, every listed file is restored. Runs locally like any command you run.',
            },
            cwd: { type: 'string', description: 'Directory to run check in. Default: the project root, the nearest folder above files with .git, pyproject.toml, package.json, composer.json, go.mod, Cargo.toml, Makefile or a similar marker; else the server\'s current folder if it holds the files, else their common folder.' },
            loop: { type: 'boolean', description: 'With check: after a missed first attempt, switch to the tool loop (default true). false retries whole replies instead (max_attempts).' },
            parallel: { type: 'integer', description: 'With check: one-shot attempts sent at once, each checked in its own copy of the tree, raced by the loop lane from the start; the first to pass wins and the rest are cancelled (default 1, max 6).' },
            loop_lane: { type: 'boolean', description: 'With check: a tool-loop lane races the one-shot attempts from the start, in its own copy of the tree (default true). false: the one-shot attempts go first, then the loop starts from their best.' },
            max_steps: { type: 'integer', description: 'With check: tool-loop steps (default 30, max 40). Raise it when a result says the loop used all its steps.' },
            verify: { type: 'boolean', description: 'With check: after it passes, the model tests the spec rules the check does not cover with its own node:assert snippets and fixes genuine failures (default false). If it cannot finish, its changes are undone.' },
            max_attempts: { type: 'integer', description: 'With check and loop: false: attempts before giving up (default 3, max 5).' },
            check_timeout_s: { type: 'integer', description: 'With check: seconds before a run is killed (default 300, max 3600). Slow suites (PHP, a full pytest run) may need more.' },
            temperature: { type: 'number', description: "Temperature for the first attempt. Default 0.6 for Qwen models (sent with Qwen's recommended top_p, top_k and presence penalty); the server's own for others." },
            retry_temperature_step: { type: 'number', description: 'With check: added to the temperature on each retry, capped at 0.8 (default 0.1; 0 keeps it flat).' },
            log_file: { type: 'string', description: 'Absolute path. Every reply and check output is appended there, for diagnosing a miss.' },
            max_tokens: { type: 'integer', description: 'Max output tokens for the first reply (default 16384).' },
            loop_max_tokens: { type: 'integer', description: 'Max output tokens per tool-loop or verify step (default 8192).' },
            think_budget: { type: 'integer', description: 'Edit tasks: once a reply has thought this many tokens with nothing written, it is cut off and the model is asked for the edits with its analysis so far, with the budget doubled on each retry up to 16384 (default 4096; 0 = no budget).' },
            loop_think_budget: { type: 'integer', description: 'The same for tool-loop and verify steps (default 1536).' },
            loop_thinking: { type: 'string', enum: ['auto', 'on', 'off'], description: 'Ask the server to skip thinking in loop steps: auto after a runaway (default), off always, on never.' },
        },
        required: ['prompt'],
    },
};

const MAX_WAIT_S = 30;
const jobId = { type: 'string', description: 'The job_id that start_warriorgpt_job returned.' };
const waitS = { type: 'integer', description: `Wait up to this many seconds for the job to finish before answering (default 0, max ${MAX_WAIT_S}). Answers as soon as it finishes.` };
const JOB_TOOLS = [
    {
        name: 'start_warriorgpt_job',
        description:
            'Start an ask_warriorgpt task in the background and return its job_id at once; takes the same arguments ' +
            'as ask_warriorgpt. Use it for anything with check: a checked task runs for minutes (one-shot attempts, ' +
            'the tool loop, the check, retries), longer than one tool call may wait. Then call ' +
            'get_warriorgpt_job_status about every 30 s (15 s in the first minute, 60 s after five; or pass wait_s to ' +
            'wait in the call), and do other work in between. When the state is done, failed or cancelled, call ' +
            'get_warriorgpt_job_result. Jobs live in this server process: they end if it restarts, and finished ' +
            'results are kept for an hour. A few run at once; the rest queue.',
        inputSchema: TOOL.inputSchema,
    },
    {
        name: 'get_warriorgpt_job_status',
        description:
            'State of a WarriorGPT job: queued, running, cancelling, done, failed or cancelled, with the time elapsed, ' +
            'progress (one-shot replies, the latest tool-loop step, request retries) and its last log lines. Without ' +
            'job_id, lists every job. Poll no more than about every 30 s (next_poll_s says when); the job does not ' +
            'move faster for it. Once it is done, failed or cancelled, get_warriorgpt_job_result has the outcome.',
        inputSchema: { type: 'object', properties: { job_id: jobId, wait_s: waitS,
            log_lines: { type: 'integer', description: 'Log lines to include (default 15, max 100).' } } },
    },
    {
        name: 'get_warriorgpt_job_result',
        description:
            'The result of a finished WarriorGPT job, exactly as ask_warriorgpt would have returned it (text, isError, ' +
            'and structuredContent with ok, fallback and attempts when the check never passed). A job that has not ' +
            'finished yet answers with its state instead; poll get_warriorgpt_job_status until it has.',
        inputSchema: { type: 'object', properties: { job_id: jobId, wait_s: waitS }, required: ['job_id'] },
    },
    {
        name: 'cancel_warriorgpt_job',
        description:
            'Cancel a WarriorGPT job: its requests and checks stop and every file it may change is put back as it ' +
            'was. A queued job is dropped at once; a running one takes a moment to stop (the state goes cancelling, ' +
            'then cancelled).',
        inputSchema: { type: 'object', properties: { job_id: jobId }, required: ['job_id'] },
    },
];

// ask_warriorgpt's reply for a finished run, or for the error it threw; job results use the same shape.
function toolResult(res) {
    const content = [{ type: 'text', text: res.text }];
    // verified false: the check passes, but the self-check did not finish.
    if (res.ok && res.verified !== undefined) {
        return { content, structuredContent: { ok: true, verified: res.verified,
            ...(res.fallback ? { fallback: res.fallback } : {}), attempts: res.attempts, ...(res.steps ? { steps: res.steps } : {}) } };
    }
    if (res.ok) return { content };
    // No attempt passed the check: say so in a form a client can branch on.
    return { content, isError: true,
        structuredContent: { ok: false, fallback: res.fallback, attempts: res.attempts, ...(res.steps ? { steps: res.steps } : {}) } };
}
const errorResult = (err) => ({ content: [{ type: 'text', text: err.message }], isError: true });

const jobs = createJobs({ run: (args, ctx) => runAsk(args, ctx) });
const FINISHED = new Set(['done', 'failed', 'cancelled']);
const seconds = (ms) => Math.round(ms / 1000);
const clock = (ms) => {
    const s = seconds(ms);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
};
// Polling more often does not make a job faster: early on it may finish soon, later it rarely does.
const nextPoll = (job) => (FINISHED.has(job.state) ? 0 : jobs.elapsedMs(job) < 60_000 ? 15 : jobs.elapsedMs(job) < 300_000 ? 30 : 60);
const waitFor = (job, args) => jobs.wait(job, Math.min(Math.max(Number(args?.wait_s) || 0, 0), MAX_WAIT_S) * 1000);
const findJob = (args) => {
    const job = args?.job_id ? jobs.get(String(args.job_id)) : null;
    if (!job) throw new UsageError(`No job ${args?.job_id ?? '(job_id missing)'}: it never existed, or finished over an hour ago, or this server restarted.`);
    return job;
};

// The next request retry, while it is still ahead.
const nextRetry = (p) => (p.next_retry && Date.parse(p.next_retry.at) > Date.now() ? p.next_retry : null);
function progressText(p) {
    const r = nextRetry(p);
    return [p.replies && `${p.replies} one-shot repl${p.replies === 1 ? 'y' : 'ies'}`, p.step,
        p.retries && `${p.retries} request retr${p.retries === 1 ? 'y' : 'ies'}`,
        r && `retry ${r.attempt} of ${r.of} at ${r.at} (${r.reason})`].filter(Boolean).join(', ') || 'starting';
}
function statusOf(job, logLines = 15) {
    const tail = logLines > 0 ? job.log.slice(-logLines) : [];
    const task = String(job.args.prompt || '').replace(/\s+/g, ' ').slice(0, 100);
    const poll = nextPoll(job);
    const text = [`job ${job.id}: ${job.state}, ${clock(jobs.elapsedMs(job))}${job.state === 'queued' ? ' waiting' : ''}` +
        `${job.state === 'queued' && job.blockedBy ? ` for ${job.blockedBy}, which may change the same files` : ''}`,
        `progress: ${progressText(job.progress)}`,
        `task: ${task}${job.args.check ? ` | check: ${job.args.check}` : ''}`,
        ...(tail.length ? ['last log lines:', ...tail.map((l) => `  ${l}`)] : []),
        FINISHED.has(job.state) ? 'Finished: call get_warriorgpt_job_result for the outcome.'
            : `Still going: check again in about ${poll} s.`].join('\n');
    return { text, structured: { job_id: job.id, state: job.state, elapsed_s: seconds(jobs.elapsedMs(job)),
        progress: { ...job.progress, next_retry: nextRetry(job.progress) }, ...(job.blockedBy && job.state === 'queued' ? { waiting_for: job.blockedBy } : {}),
        ...(poll ? { next_poll_s: poll } : {}), log_tail: tail } };
}

async function callJobTool(name, args) {
    if (name === 'start_warriorgpt_job') {
        const job = jobs.start(args || {});
        // Bad arguments fail before the run does any work: report them now rather than on the first poll.
        await new Promise((done) => setImmediate(done));
        if (job.state === 'failed' && job.error instanceof UsageError) return errorResult(job.error);
        const ahead = job.state === 'queued' ? `; ${jobs.stats().waiting} queued, ${jobs.stats().running} running` : '';
        return { content: [{ type: 'text', text: `Started job ${job.id} (${job.state}${ahead}). Call get_warriorgpt_job_status ` +
            'with this job_id in about 15 s, then about every 30 s, doing other work in between; when it is done, failed ' +
            'or cancelled, call get_warriorgpt_job_result.' }], structuredContent: { job_id: job.id, state: job.state } };
    }
    if (name === 'get_warriorgpt_job_status') {
        const n = Math.min(Math.max(args?.log_lines === undefined ? 15 : Number(args.log_lines) || 0, 0), 100);
        if (!args?.job_id) {
            const all = jobs.list().map((j) => statusOf(j, 0));
            return { content: [{ type: 'text', text: all.length ? all.map((s) => s.text.split('\n').slice(0, 2).join('; ')).join('\n')
                : 'No jobs.' }], structuredContent: { jobs: all.map((s) => s.structured) } };
        }
        const job = findJob(args);
        await waitFor(job, args);
        const { text, structured } = statusOf(job, n);
        return { content: [{ type: 'text', text }], structuredContent: structured };
    }
    if (name === 'get_warriorgpt_job_result') {
        const job = findJob(args);
        await waitFor(job, args);
        if (job.state === 'done') return toolResult(job.result);
        if (job.state === 'failed') return errorResult(job.error);
        if (job.state === 'cancelled') {
            return { content: [{ type: 'text', text: `Job ${job.id} was cancelled; every file it could change is back as it was.` }], isError: true };
        }
        const { text, structured } = statusOf(job, 5);
        return { content: [{ type: 'text', text: `Not finished yet. ${text}` }], structuredContent: structured };
    }
    // cancel_warriorgpt_job
    const job = findJob(args);
    jobs.cancel(job);
    // Give the run a moment to unwind and restore the files, so the answer is usually final.
    await jobs.wait(job, 5000);
    const { text, structured } = statusOf(job, 3);
    return { content: [{ type: 'text', text }], structuredContent: structured };
}

// A plain ask_warriorgpt run, cancellable like a job when the server is told to stop.
const asks = new Set();
async function ask(args, progressToken) {
    const ctl = new AbortController();
    const progress = { replies: 0, step: null, retries: 0, phase: null, next_retry: null };
    let n = 0;
    let last = '';
    // With a progressToken, every step, reply or retry becomes a notifications/progress message.
    const onLog = progressToken === undefined ? undefined : (text) => {
        for (const line of String(text).split('\n')) track(progress, line.trimEnd());
        const now = progressText(progress);
        if (now === last) return;
        last = now;
        send({ method: 'notifications/progress', params: { progressToken, progress: ++n, message: now } });
    };
    const run = runAsk(args, { signal: ctl.signal, onLog });
    const entry = { ctl, done: run.catch(() => {}) };
    asks.add(entry);
    try {
        return await run;
    } finally {
        asks.delete(entry);
    }
}

const TOOL_NAMES = () => [TOOL, ...JOB_TOOLS].map((t) => t.name).join(', ');

function send(msg) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
}

async function handle(req) {
    const { id, method, params } = req;
    switch (method) {
        case 'initialize':
            return send({ id, result: {
                protocolVersion: params?.protocolVersion || '2025-06-18',
                capabilities: { tools: {} },
                serverInfo: { name: 'warriorgpt', version: '1.0.0' },
            } });
        case 'ping':
            return send({ id, result: {} });
        case 'tools/list':
            return send({ id, result: { tools: [TOOL, ...JOB_TOOLS] } });
        case 'tools/call':
            if (params?.name === TOOL.name) {
                try {
                    return send({ id, result: toolResult(await ask(params.arguments || {}, params?._meta?.progressToken)) });
                } catch (err) {
                    return send({ id, result: errorResult(err) });
                }
            }
            if (!JOB_TOOLS.some((t) => t.name === params?.name)) {
                return send({ id, error: { code: -32602, message: `Unknown tool ${params?.name}; the tools are ${TOOL_NAMES()}` } });
            }
            try {
                return send({ id, result: await callJobTool(params.name, params.arguments) });
            } catch (err) {
                return send({ id, result: errorResult(err) });
            }
        default:
            // Notifications (no id) need no reply.
            if (id !== undefined) send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
}

try {
    const { values } = parseArgs({ options: { 'max-concurrency': { type: 'string' } } });
    if (values['max-concurrency'] !== undefined) setMaxConcurrency(values['max-concurrency']);
} catch (err) {
    process.stderr.write(`warriorgpt-mcp: ${err.message}\n`);
    process.exit(2);
}

// The client is gone: nobody can read a job's result, so its runs stop and put the files back. A plain
// ask_warriorgpt call still in flight finishes as before.
// SIGTERM or SIGINT stops every run, job or plain call, and exits once their files are restored (at most 10 s).
let stopping = false;
const stopAll = async (code) => {
    if (stopping) return;
    stopping = true;
    for (const a of asks) a.ctl.abort();
    const guard = setTimeout(() => process.exit(code), 10_000);
    await Promise.all([jobs.cancelAll(), ...[...asks].map((a) => a.done)]);
    clearTimeout(guard);
    process.exit(code);
};
process.on('SIGTERM', () => stopAll(143));
process.on('SIGINT', () => stopAll(130));

createInterface({ input: process.stdin }).on('close', () => jobs.cancelAll()).on('line', (line) => {
    if (!line.trim()) return;
    let req;
    try {
        req = JSON.parse(line);
    } catch {
        return send({ id: null, error: { code: -32700, message: 'Parse error' } });
    }
    handle(req);
});
