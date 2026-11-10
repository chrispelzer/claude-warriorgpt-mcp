// The ask_warriorgpt core, shared by the MCP server and the warriorgpt-ask CLI.

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { dirname, resolve, join, sep } from 'node:path';
import { unfence, writeFiles, planFiles, writePlan } from './edits.mjs';
import { runLoop, FIX_SYSTEM, VERIFY_SYSTEM, VERIFY_THINK_BUDGET, VERIFY_MS } from './loop.mjs';
import { makeCopy, inside, CantCopyError } from './workspace.mjs';
import { availableParallelism } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { API_BASE, DEFAULT_MODEL, STATE_DIR, SESSION, apiKey, missingKeyMessage } from './common.mjs';
import { backoffMs, errorBody, isTransientNetworkError, maxRetries, rateLimitWait, retryAfterMs, sleep } from './retry.mjs';

const API_URL = `${API_BASE}/chat/completions`;
export const MODELS = {
    'local.qwen3.8-27b': 'Qwen 3.8 27B, 262k context. Best general coder (default).',
    'local.gpt-oss-120b': 'GPT-OSS 120B, 131k context. Stronger reasoning, slower.',
    'local.laguna-s-2.1': 'Laguna S 2.1, 131k context.',
    'local.gemma-4-31b': 'Gemma 4 31B, 131k context.',
};

const FILES_FORMAT = `Reply with only file blocks and no other text. For each file you create or change:

=== FILE: <absolute path> ===
<body>
=== END FILE ===

For a new file, the body is the complete file contents. For an existing file, the body is one or more
edit blocks instead:

<<<<<<< SEARCH
lines copied exactly from the current file, enough of them to match only one place
=======
the lines that replace them
>>>>>>> REPLACE

Only write files from the allowed list, and leave out files that need no change.`;

// Bad arguments: the caller's mistake (the CLI exits 2).
export class UsageError extends Error {}
// The API did not answer or refused the request (the CLI exits 3).
export class ApiError extends Error {}
// A request aborted on purpose (a parallel attempt that lost the race).
export class CancelledError extends Error {}

// Windows briefly locks freshly written files (antivirus scan, late handle close); retry the transient EBUSY/EPERM instead of failing the run.
const withLockRetry = (fn) => {
    for (let n = 0; ; n++) {
        try { return fn(); }
        catch (err) {
            // Up to ~1.4 s in all: 100 ms was not enough on a CI runner.
            if (n >= 7 || (err.code !== 'EBUSY' && err.code !== 'EPERM')) throw err;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (n + 1));
        }
    }
};

const MAX_ATTEMPTS = 5;
// Qwen3 thinking-mode sampling from the model cards; the presence penalty fights the endless repetition that runaway thinking looks like.
export const QWEN_SAMPLING = { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0, presence_penalty: 1.0 };
export const samplingFor = (model, temperature) => {
    const base = /qwen/i.test(model) ? { ...QWEN_SAMPLING } : {};
    if (temperature !== undefined) base.temperature = temperature;
    return base;
};
// Retries run a little hotter so a model stuck on one wrong idea tries another, but never past MAX_TEMPERATURE:
// hotter replies broke the reply format. Without a temperature, retries count up from 0.6 (Qwen's recommended setting).
const RETRY_TEMPERATURE_BASE = 0.6;
// Replies that spent the whole budget thinking are retried without using up an attempt, at most this often.
const MAX_FREE_RETRIES = 2;
export const FALLBACK_HINT = 'fallback: opencode. Hand this task to an agent that can run the tests and read the code ' +
    '(for example warriorgpt-delegate, or your OpenCode subagent).';
export const MAX_TEMPERATURE = 0.8;
const CHECK_OUTPUT_CHARS = 4000;
// The loop lane is the main path on hard tasks; OpenCode has no step cap, and lower caps made lanes give up too early.
const DEFAULT_STEPS = 30;
const MAX_STEPS = 40;
// A self-check makes about one edit per step, so it needs headroom to finish a fix.
const VERIFY_STEPS = 8;
// Parallel first attempts: vLLM batches them, so several cost about the time of one. Default to one: on hard tasks
// the cut-off one-shot attempts lost every time to the always-on, uncut tool-loop lane.
export const DEFAULT_PARALLEL = 1;
// A race attempt still thinking past its budget after one reissue is dropped: such attempts never wrote anything.
const RACE_FREE_RETRIES = 1;
// The portfolio race: thinking budgets of 1x, 3x and 5x think_budget, each cut off once and reissued with a short
// budget, then dropped. Output caps are budget + max_tokens, at most RACE_MAX_TOKENS, so no attempt stalls the race.
const PORTFOLIO_SCALES = [1, 3, 5];
const RACE_MAX_TOKENS = 32768;
// The loop lane's output cap per step: with a bigger cap a step could think for minutes before its first tool call.
// A cut-off step keeps its reasoning through the runaway nudge.
const LANE_MAX_TOKENS = 16384;
const MAX_PARALLEL = 6;
const PARALLEL_TEMPERATURES = [0.6, 0.3, 0.8, 0.45, 0.7, 0.5];
// A loop step is one small action, so it gets less output than a full reply.
export const DEFAULT_MAX_TOKENS = 16384;
export const DEFAULT_LOOP_MAX_TOKENS = 8192;
// Client-side thinking budgets, in tokens: the stream is cut off once reasoning passes the budget with nothing
// written yet, since a runaway can cost minutes.
export const DEFAULT_THINK_BUDGET = 4096;
export const DEFAULT_LOOP_THINK_BUDGET = 1536;
// Reasoning text is about four characters per token for these models; used while the stream is still running.
const CHARS_PER_TOKEN = 4;
// The one-shot reissue quotes only this much of a cut-off analysis; the tool loop sends the whole reasoning_content
// back instead, as a field of the assistant turn.
const ANALYSIS_TAIL_CHARS = 12000;
const fence = (path, body) => `\n\nFile: ${path}\n\`\`\`\n${body}\n\`\`\``;

// chat_template_kwargs.enable_thinking: false asks vLLM to skip thinking; a server that rejects it is detected
// once and it is not sent again.
let thinkingSwitchRejected = false;
export const thinkingSwitchState = () => (thinkingSwitchRejected ? 'rejected' : 'sent');

// Collects an OpenAI-style SSE stream into the shape of a non-streamed reply. stopAt(reasoningChars) is asked
// after every chunk until something is written; wrap (an AbortSignal) cancels at once unless writing has begun.
const WRAPPED = Symbol('wrapped');
async function readStream(body, { stopAt, mark, progress = {}, wrap } = {}) {
    const decoder = new TextDecoder();
    let buf = '', content = '', reasoningText = '', reasoning = 0, finish, usage, stopped = false;
    const calls = [];
    const take = (line) => {
        if (!line.startsWith('data:')) return;
        const raw = line.slice(5).trim();
        if (!raw || raw === '[DONE]') return;
        const chunk = JSON.parse(raw);
        if (chunk.error) {
            throw Object.assign(new ApiError(`WarriorGPT error mid-reply: ${JSON.stringify(chunk.error).slice(0, 500)}`),
                // The gateway's marker for a stream its upstream dropped: worth another try.
                chunk.error.code === 'upstream_stream_incomplete' ? { retry: 'the stream was cut off (upstream_stream_incomplete)' } : {});
        }
        const choice = chunk.choices?.[0];
        const thought = choice?.delta?.reasoning ?? choice?.delta?.reasoning_content;
        if (thought) {
            mark?.('reasoning');
            reasoning += thought.length;
            progress.chars = (progress.chars || 0) + thought.length;
            reasoningText += thought; // all of it: the loop returns it to the server as the turn's reasoning_content
        }
        if (choice?.delta?.content) {
            mark?.('content');
            content += choice.delta.content;
            progress.chars = (progress.chars || 0) + choice.delta.content.length;
        }
        // Tool calls arrive in pieces keyed by index: the id and name first, then the arguments in fragments.
        for (const d of choice?.delta?.tool_calls || []) {
            mark?.('content');
            const i = d.index ?? calls.length;
            const c = calls[i] ||= { id: '', type: 'function', function: { name: '', arguments: '' } };
            if (d.id) c.id = d.id;
            if (d.function?.name) c.function.name += d.function.name;
            if (d.function?.arguments) c.function.arguments += d.function.arguments;
        }
        if (choice?.finish_reason) finish = choice.finish_reason;
        if (chunk.usage) usage = chunk.usage;
    };
    const it = body[Symbol.asyncIterator] ? body[Symbol.asyncIterator]() : body[Symbol.iterator]();
    let wrapped = wrap ? new Promise((done) => {
        if (wrap.aborted) done(WRAPPED);
        else wrap.addEventListener('abort', () => done(WRAPPED), { once: true });
    }) : null;
    let pending = null;
    for (;;) {
        pending ||= Promise.resolve(it.next());
        const next = wrapped ? await Promise.race([pending, wrapped]) : await pending;
        if (next === WRAPPED) {
            wrapped = null;
            if (!content.trim() && !calls.length) {
                stopped = true;
                pending.catch(() => {}); // the request is cancelled next; its read then fails, unheard
                it.return?.()?.catch?.(() => {});
                break;
            }
            continue; // already writing: let it finish
        }
        pending = null;
        if (next.done) break;
        const part = next.value;
        progress.bytes = (progress.bytes || 0) + part.length;
        buf += typeof part === 'string' ? part : decoder.decode(part, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
            take(buf.slice(0, i).trim());
            buf = buf.slice(i + 1);
        }
        if (stopAt && !content.trim() && !calls.length && stopAt(reasoning)) {
            stopped = true;
            it.return?.()?.catch?.(() => {}); // cancels the body, which closes the request
            break;
        }
    }
    if (!stopped) take(buf.trim());
    // A stream that closes without a finish reason was cut short: its content is partial, so it is not a reply.
    if (!stopped && (!finish || finish === 'incomplete')) {
        throw Object.assign(new Error('the stream ended before the reply finished'), { retry: 'the stream was cut off before it finished' });
    }
    return { usage, reasoningChars: reasoning, reasoningText, stopped,
        choices: [{ finish_reason: stopped ? 'think_budget' : finish,
            message: { content, ...(calls.length ? { tool_calls: calls.filter(Boolean) } : {}) } }] };
}

// Requests in flight, for the "WarriorGPT is working" marker file; parallel requests share it.
let inFlight = 0;

// One request. thinkBudget (tokens, 0 = none) cuts the stream off once reasoning passes it with nothing written;
// noThinking asks the server to skip thinking; signal aborts the request from outside (a parallel attempt that lost).
// A 429, a connection that failed before any reply, or a stream cut short is sent again after a backoff (say logs
// it).
async function chat(key, { model, messages, maxTokens, attempt, sampling = {}, tools, thinkBudget = 0, noThinking = false,
    signal, wrap, say } = {}) {
    const activeFile = join(STATE_DIR, `active-${SESSION}`);
    if (inFlight++ === 0) {
        mkdirSync(STATE_DIR, { recursive: true });
        writeFileSync(activeFile, '');
    }
    let t0 = performance.now();
    let times = {};
    const mark = (what) => { times[what] ??= Math.round(performance.now() - t0); };
    const progress = { chars: 0 };
    // A request cancelled from outside still generated tokens: the error carries an estimate.
    const cancelled = () => Object.assign(new CancelledError('cancelled'), { usage: {
        in: Math.round(JSON.stringify(messages).length / CHARS_PER_TOKEN), out: Math.round(progress.chars / CHARS_PER_TOKEN),
        reasoning: 0, estimated: true } });
    let data;
    const tries = maxRetries() + 1;
    const started = Date.now();
    try {
        for (let n = 1; ; n++) {
            let wait;
            t0 = performance.now();
            times = {};
            progress.bytes = 0;
            try {
                data = await chatOnce();
                break;
            } catch (err) {
                if (!err.retry || n >= tries) {
                    if (err.retry && n > 1) err.message += ` (gave up after ${n} tries in ${Math.round((Date.now() - started) / 1000)} s)`;
                    throw err;
                }
                wait = Math.max(err.waitMs || 0, backoffMs(n));
                const note = `--- WarriorGPT: ${err.retry}; retry ${n} of ${tries - 1} in ${(wait / 1000).toFixed(1)} s`;
                say?.(note);
                process.stderr.write(`warriorgpt: ${note.slice(4)}\n`);
            }
            try {
                await sleep(wait, signal);
            } catch {
                throw cancelled();
            }
        }
    } finally {
        if (--inFlight === 0) rmSync(activeFile, { force: true });
    }
    async function chatOnce() {
        const cancel = new AbortController();
        const send = (withSwitch) => fetch(API_URL, {
            method: 'POST',
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            // Streamed: the gateway ends a non-streamed request that runs past 120 s with a 500.
            body: JSON.stringify({ model, messages, max_tokens: maxTokens, ...sampling, ...(tools ? { tools, parallel_tool_calls: true } : {}),
                ...(withSwitch ? { chat_template_kwargs: { enable_thinking: false } } : {}),
                stream: true, stream_options: { include_usage: true } }),
            signal: AbortSignal.any([cancel.signal, AbortSignal.timeout(15 * 60 * 1000), ...(signal ? [signal] : [])]),
        });
        let res;
        try {
            let withSwitch = noThinking && !thinkingSwitchRejected;
            res = await send(withSwitch);
            if (!res.ok && withSwitch && (res.status === 400 || res.status === 422)) {
                // A strict server refused the thinking switch: remember that for this process and resend without it.
                thinkingSwitchRejected = true;
                await res.text().catch(() => '');
                withSwitch = false;
                res = await send(false);
            }
        } catch (err) {
            if (signal?.aborted) throw cancelled();
            const why = `${err.message}${err.cause?.code || err.cause?.message ? ` (${err.cause.code || err.cause.message})` : ''}`;
            throw Object.assign(new ApiError(`WarriorGPT unreachable: ${why}`),
                isTransientNetworkError(err) ? { retry: `unreachable: ${why}` } : {});
        }
        mark('headers');
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            if (res.status !== 429) throw new ApiError(`WarriorGPT ${res.status}: ${text.slice(0, 500)}`);
            // Busy key: wait as long as the server says. A quota denial or a wait of minutes fails now, with its message.
            const { message, code } = errorBody(text);
            const after = retryAfterMs(res.headers?.get?.('retry-after'));
            const waitMs = rateLimitWait(code, after);
            throw Object.assign(new ApiError(`WarriorGPT 429${code ? ` (${code})` : ''}: ${message.slice(0, 500)}` +
                `${after !== null ? ` [Retry-After ${Math.round(after / 100) / 10} s]` : ''}`),
                waitMs === null ? {} : { retry: `429${code ? ` ${code}` : ''}: ${message.slice(0, 200)}`, waitMs });
        }
        let reply;
        try {
            const stopAt = thinkBudget > 0 ? (chars) => chars / CHARS_PER_TOKEN > thinkBudget : undefined;
            reply = (res.headers?.get?.('content-type') || '').includes('text/event-stream')
                ? await readStream(res.body, { stopAt, mark, progress, wrap }) : await res.json();
        } catch (err) {
            if (signal?.aborted) throw cancelled();
            // A connection that dropped before any byte of the reply is the same as one that never opened.
            const retry = err.retry || (!progress.bytes && isTransientNetworkError(err) ? `the connection dropped before the reply: ${err.message}` : undefined);
            const out = err instanceof ApiError ? err : new ApiError(`WarriorGPT reply broke off: ${err.message}`);
            if (retry) out.retry = retry;
            cancel.abort();
            throw out;
        }
        if (reply.choices?.[0]?.finish_reason === 'incomplete') {
            throw Object.assign(new ApiError('WarriorGPT reply broke off: the stream ended before the reply finished (finish_reason incomplete)'),
                { retry: 'the stream was cut off (finish_reason incomplete)' });
        }
        if (reply.stopped) cancel.abort();
        return reply;
    }
    mark('end');
    const choice = data.choices?.[0];
    const text = choice?.message?.content ?? '';
    // A cut-off stream has no usage block: estimate from the text sent and the reasoning received.
    const estimated = !data.usage;
    const usage = estimated
        ? { in: Math.round(JSON.stringify(messages).length / CHARS_PER_TOKEN),
            out: Math.round(((data.reasoningChars || 0) + text.length) / CHARS_PER_TOKEN) }
        : { in: data.usage.prompt_tokens || 0, out: data.usage.completion_tokens || 0 };
    appendFileSync(join(STATE_DIR, 'usage.jsonl'), JSON.stringify({ ts: new Date().toISOString(), session: SESSION,
        model, ...usage, ...(estimated ? { estimated: true } : {}), ...(attempt ? { attempt } : {}) }) + '\n');
    // Reasoning tokens when the server reports them; otherwise estimated from the streamed reasoning text.
    const reasoning = data.usage?.completion_tokens_details?.reasoning_tokens
        ?? Math.round((data.reasoningChars ?? (choice?.message?.reasoning ?? choice?.message?.reasoning_content ?? '').length) / CHARS_PER_TOKEN);
    const toolCalls = (choice?.message?.tool_calls || []).map((c, i) => ({ id: c.id || `call_${i}`,
        name: c.function?.name || '', arguments: typeof c.function?.arguments === 'string' ? c.function.arguments
            : JSON.stringify(c.function?.arguments ?? {}) }));
    // Where the time went: response headers, first reasoning, first content or tool call, end (ms from send).
    return { text, finish: choice?.finish_reason, usage: { ...usage, reasoning, ...(estimated ? { estimated: true } : {}) },
        toolCalls, timing: times,
        reasoningText: data.reasoningText ?? (choice?.message?.reasoning_content ?? choice?.message?.reasoning ?? '') };
}

// A reply that spent its budget thinking has nothing usable, and the same request tends to repeat it; it is
// retried with an order to stop thinking, without using up an attempt.
export const RUNAWAY_SHARE = 0.9;
export function isRunaway(reply, needBlocks, maxTokens = 0) {
    if (reply.finish === 'length') {
        if (!reply.text.trim()) return true;
        return reply.usage.reasoning >= 0.8 * reply.usage.out && (!needBlocks || !reply.text.includes('=== FILE:'));
    }
    const usable = needBlocks ? reply.text.includes('=== FILE:') : !!reply.text.trim();
    return !usable && maxTokens > 0 && reply.usage.reasoning > RUNAWAY_SHARE * maxTokens;
}
const runawayPrompt = (out, files) => `Your last reply spent its output budget (${out} tokens) on thinking and ` +
    'wrote nothing usable. Stop thinking now: think for a few short paragraphs at most, then write ' +
    `${files ? 'the file blocks' : 'your answer'} right away.`;
const budgetPrompt = (analysis, files) => 'Your analysis so far (cut off at the thinking budget):\n<<<\n' +
    `${analysis.trim().slice(-ANALYSIS_TAIL_CHARS)}\n>>>\n\nStop analysing. ${typeof files === 'string' ? files
        : files ? 'Output the file blocks with your edits now.' : 'Write your answer now.'}`;

function limiter(n) {
    let active = 0;
    const queue = [];
    const next = () => {
        if (active >= n || !queue.length) return;
        active++;
        const [job, ok, fail] = queue.shift();
        job().then(ok, fail).finally(() => {
            active--;
            next();
        });
    };
    return (job) => new Promise((ok, fail) => {
        queue.push([job, ok, fail]);
        next();
    });
}

// How many tests failed, from node:test (TAP or spec reporter) or mocha-style output; unknown counts as many.
export function failCount(output) {
    const m = output.match(/^\s*(?:ℹ|#) fail (\d+)/m) || output.match(/(\d+) failing/);
    return m ? Number(m[1]) : 1e6;
}
export const timingText = (t = {}) => [t.headers !== undefined && `headers ${t.headers} ms`,
    t.reasoning !== undefined && `first reasoning ${t.reasoning} ms`, t.content !== undefined && `first output ${t.content} ms`,
    t.end !== undefined && `end ${t.end} ms`].filter(Boolean).join(', ');
const cutOffPrompt = (out) => `Your reply was cut off at the output limit (${out} tokens) before it was complete, so ` +
    'nothing was written. Send fewer, shorter edit blocks: change only the lines that need it, and do not ' +
    'rewrite whole files or repeat unchanged code.';

function killTree(child) {
    if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
        try {
            process.kill(-child.pid, 'SIGKILL');
        } catch {
            child.kill('SIGKILL');
        }
    }
}

// Runs a process and collects its output. stdin is closed unless input is given: on the MCP server our own
// stdin is the JSON-RPC stream. signal kills it early; the result carries ms, spawn to exit.
function runProcess(command, args, { cwd, timeoutS, shell = false, input, signal }) {
    return new Promise((done) => {
        // Cancelled while it waited for a check slot or a tree copy: a listener added now would never fire.
        if (signal?.aborted) return done({ ok: false, code: null, timedOut: false, cancelled: true, output: '', ms: 0 });
        const t0 = performance.now();
        // The key stays out of the child: a model-written snippet could otherwise print it into the log.
        const env = { ...process.env };
        delete env.WARRIORGPT_API_KEY;
        const child = spawn(command, args, { cwd, shell, windowsHide: true, env,
            stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
        if (input !== undefined) {
            child.stdin.on('error', () => {});
            child.stdin.end(input);
        }
        let output = '';
        const add = (d) => {
            output += d;
            if (output.length > 200_000) output = output.slice(-100_000);
        };
        child.stdout.on('data', add);
        child.stderr.on('data', add);
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            killTree(child);
        }, timeoutS * 1000);
        const onAbort = () => killTree(child);
        signal?.addEventListener('abort', onAbort, { once: true });
        child.on('error', (err) => { output += `\n${err.message}`; });
        child.on('close', (code) => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            done({ ok: code === 0 && !timedOut && !signal?.aborted, code, timedOut, cancelled: !!signal?.aborted,
                output: output.trim(), ms: Math.round(performance.now() - t0) });
        });
    });
}

// A check that is just `node ...` in plain or double-quoted words is spawned directly (the shell hop costs time
// on Windows); `node` becomes this Node binary. Anything that needs a shell gets null and runs in the shell.
const SHELL_SYNTAX = /[|&;<>()$`^%!\r\n'{}~]/;
export function splitCommand(command, platform = process.platform, execPath = process.execPath) {
    if (typeof command !== 'string' || SHELL_SYNTAX.test(command)) return null;
    if (platform !== 'win32' && command.includes('\\')) return null;
    const words = command.match(/(?:"[^"]*"|[^\s"]+)+/g) || [];
    // Every character must belong to a word or be blank: an unpaired quote leaves one over.
    if (command.replace(/(?:"[^"]*"|[^\s"]+)+/g, '').trim() || !words.length) return null;
    const argv = [];
    for (const w of words) {
        if (/[*?[\]]/.test(w.replace(/"[^"]*"/g, ''))) return null; // a glob outside quotes: the shell would expand it
        argv.push(w.replace(/"/g, ''));
    }
    const first = platform === 'win32' ? argv[0].toLowerCase() : argv[0];
    const self = platform === 'win32' ? execPath.toLowerCase() : execPath;
    if (first === 'node' || (platform === 'win32' && first === 'node.exe')) argv[0] = execPath;
    else if (first !== self) return null;
    return argv;
}

const runCheck = (command, cwd, timeoutS, signal) => {
    const argv = splitCommand(command);
    return argv ? runProcess(argv[0], argv.slice(1), { cwd, timeoutS, signal })
        : runProcess(command, [], { cwd, timeoutS, shell: true, signal });
};

// A model-written snippet: this same Node binary, no shell, the source on stdin as an ES module. Node's permission
// model keeps it inside its working directory (plus the readOnly dirs) and bars processes, workers and addons.
const NODE_TIMEOUT_S = 30;
const [NODE_MAJOR, NODE_MINOR] = process.versions.node.split('.').map(Number);
// --permission is stable from Node 22.13 / 23.5; older 22.x only has the experimental flag.
export const PERMISSION_FLAG = NODE_MAJOR > 23 || (NODE_MAJOR === 23 && NODE_MINOR >= 5) || (NODE_MAJOR === 22 && NODE_MINOR >= 13)
    ? '--permission' : '--experimental-permission';
// Each path is allowed as given and as its real path: the permission model checks real paths, and on macOS the
// temp folder /var/... is a link to /private/var/....
const withReal = (d) => {
    let real = d;
    try { real = realpathSync(d); } catch { /* missing: allow it as given */ }
    return real === d ? [d] : [d, real];
};
export function runNodeArgs(cwd, readOnly = []) {
    const reads = [...new Set([cwd, ...readOnly].filter(Boolean).flatMap(withReal))];
    return [PERMISSION_FLAG, ...reads.map((d) => `--allow-fs-read=${d}`), ...withReal(cwd).map((d) => `--allow-fs-write=${d}`),
        '--input-type=module', '-'];
}
const runNode = (code, cwd, signal, readOnly) => runProcess(process.execPath, runNodeArgs(cwd, readOnly),
    { cwd, timeoutS: NODE_TIMEOUT_S, input: code, signal });

function tail(text, n) {
    return text.length > n ? `[...${text.length - n} chars cut]\n${text.slice(-n)}` : text;
}

function commonDir(paths) {
    const parts = paths.map((p) => dirname(p).split(sep));
    let n = parts[0].length;
    for (const p of parts) {
        let i = 0;
        while (i < n && i < p.length && p[i].toLowerCase() === parts[0][i].toLowerCase()) i++;
        n = i;
    }
    return parts[0].slice(0, n).join(sep) || sep;
}

// Lines added and removed, by longest common subsequence (a multiset count for very large files).
function lineDelta(before, after) {
    const a = before === null ? [] : before.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
    const b = after === null ? [] : after.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
    let kept = 0;
    if (a.length * b.length > 4_000_000) {
        const count = new Map();
        for (const l of a) count.set(l, (count.get(l) || 0) + 1);
        for (const l of b) {
            if (count.get(l) > 0) {
                count.set(l, count.get(l) - 1);
                kept++;
            }
        }
    } else {
        let prev = new Array(b.length + 1).fill(0);
        for (let i = 1; i <= a.length; i++) {
            const row = new Array(b.length + 1).fill(0);
            for (let j = 1; j <= b.length; j++) {
                row[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], row[j - 1]);
            }
            prev = row;
        }
        kept = prev[b.length];
    }
    return { added: b.length - kept, removed: a.length - kept };
}

// After a miss the edits stay on disk, as an agent's would: the model sees the files as they are now and fixes
// only what failed, instead of redoing the whole change from the originals.
const retryPrompt = (check, failure, current) => `${failure}

Your earlier edits are still in place. Every allowed file as it is NOW:${current}

Reply with file blocks that fix what failed, so that \`${check}\` passes. Write SEARCH text against the
current contents above, not the versions in my first message. Change only what is needed; keep what already works.`;

// Returns { ok, text, attempts, usage, files, fallback? }; ok is false only when a check never passed (then
// fallback is 'opencode'); every other problem throws: UsageError, ApiError, or Error for an unapplied reply.
export async function runAsk(args) {
    const key = apiKey();
    if (!key) throw new UsageError(missingKeyMessage());
    if (!args.prompt) throw new UsageError('prompt is required.');

    if (args.files?.length && args.output_file) throw new UsageError('Pass files or output_file, not both.');
    const files = (args.files || []).map((p) => resolve(p));
    const check = args.check?.trim() || '';
    if (check && !files.length) throw new UsageError('check needs files: it runs after the edits are written.');
    // With the tool loop (the default with check): one one-shot attempt, then the loop. Without it: retries.
    const loop = !!check && args.loop !== false && args.loop !== 'false';
    const verify = !!check && (args.verify === true || args.verify === 'true');
    // The self-check's time limit; WARRIORGPT_VERIFY_MS overrides it (tests use a short one).
    const verifyMs = Number(process.env.WARRIORGPT_VERIFY_MS) || VERIFY_MS;
    const maxAttempts = loop ? 1 : check ? Math.min(Math.max(Number(args.max_attempts) || 3, 1), MAX_ATTEMPTS) : 1;
    // The one-shot attempts race the loop lane (it starts from the best of them when none passes).
    const parallelArg = args.parallel === undefined || args.parallel === null || args.parallel === '' ? DEFAULT_PARALLEL : Number(args.parallel);
    if (!(parallelArg >= 1)) throw new UsageError('parallel must be a number >= 1.');
    const parallel = loop ? Math.min(Math.floor(parallelArg), MAX_PARALLEL) : 1;
    // The loop lane: the tool loop races the one-shot attempts from the start, in its own copy of the tree. loop_lane: false turns it off.
    const loopLane = loop && args.loop_lane !== false && args.loop_lane !== 'false';
    const maxSteps = Math.min(Math.max(Number(args.max_steps) || DEFAULT_STEPS, 1), MAX_STEPS);
    const checkTimeout = Math.min(Math.max(Number(args.check_timeout_s) || 300, 1), 3600);
    const cwd = args.cwd ? resolve(args.cwd) : files.length ? commonDir(files) : process.cwd();
    if (check && !existsSync(cwd)) throw new UsageError(`cwd does not exist: ${cwd}`);
    const model = args.model || DEFAULT_MODEL;
    const maxTokens = Number(args.max_tokens) || DEFAULT_MAX_TOKENS;
    const loopMaxTokens = Math.min(Number(args.loop_max_tokens) || DEFAULT_LOOP_MAX_TOKENS, maxTokens);
    const budget = (v, d) => (v === undefined || v === null || v === '' ? d : Math.max(Number(v) || 0, 0));
    // The thinking budget applies to edit tasks; a plain question may think as long as it likes.
    const thinkBudget = files.length || args.output_file ? budget(args.think_budget, DEFAULT_THINK_BUDGET) : 0;
    const loopThinkBudget = budget(args.loop_think_budget, DEFAULT_LOOP_THINK_BUDGET);
    const loopThinking = args.loop_thinking || 'auto';
    if (!['auto', 'on', 'off'].includes(loopThinking)) throw new UsageError('loop_thinking must be auto, on or off.');
    const num = (v) => (v === undefined || v === null || v === '' ? undefined : Number(v));
    const temperature = num(args.temperature);
    const step = num(args.retry_temperature_step) ?? 0.1;
    if ([temperature, step].some((v) => v !== undefined && !(v >= 0))) throw new UsageError('temperature and retry_temperature_step must be numbers >= 0.');
    const temperatureFor = (attempt) => {
        if (attempt === 1 || !step) return temperature;
        return Math.round(Math.min((temperature ?? RETRY_TEMPERATURE_BASE) + step * (attempt - 1), MAX_TEMPERATURE) * 100) / 100;
    };

    let contextText = '';
    for (const path of args.context_files || []) contextText += fence(resolve(path), readFileSync(resolve(path), 'utf8'));
    let user = args.prompt + contextText;
    if (files.length) {
        user += `\n\nAllowed files:\n${files.map((f) => `- ${f}${existsSync(f) ? '' : ' (new)'}`).join('\n')}`;
        for (const f of files.filter((f) => existsSync(f))) user += fence(f, readFileSync(f, 'utf8'));
    }
    if (check) user += `\n\nAfter your edits are written, this command must pass (run in ${cwd}): ${check}`;
    const system = [
        args.system,
        args.output_file && 'Reply with only the complete contents of the requested file: no explanation, no markdown fences.',
        files.length && FILES_FORMAT,
    ].filter(Boolean).join('\n\n');
    const messages = [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: user }];

    // Optional attempt log: every reply in full and every check's output, so a miss can be diagnosed later.
    const logFile = args.log_file ? resolve(args.log_file) : null;
    const log = (text) => {
        if (!logFile) return;
        mkdirSync(dirname(logFile), { recursive: true });
        withLockRetry(() => appendFileSync(logFile, text.endsWith('\n') ? text : `${text}\n`));
    };
    log(`=== warriorgpt-ask ${new Date().toISOString()} | ${model} | check: ${check || '(none)'} | cwd: ${cwd}\n` +
        `files: ${files.join(', ') || '(none)'}`);

    // Retries build on the files as the last attempt left them; a check that never passes restores the originals.
    const snapshot = new Map(files.map((f) => [f, existsSync(f) ? withLockRetry(() => readFileSync(f)) : null]));
    const restore = () => {
        for (const [f, buf] of snapshot) {
            if (buf === null) rmSync(f, { force: true });
            else withLockRetry(() => writeFileSync(f, buf));
        }
    };
    const total = { in: 0, out: 0 };
    let requests = 0;
    const statsFor = () => `${model}${requests > 1 ? `, ${requests} requests` : ''}, ${total.in} in / ${total.out} out tokens`;
    // History is the first request plus only the latest reply and retry: the retry carries the current files,
    // so older turns add length without adding anything the model needs.
    const base = messages.length;
    const current = () => files.map((f) => (existsSync(f) ? fence(f, readFileSync(f, 'utf8'))
        : `\n\nFile: ${f}\n(does not exist yet)`)).join('');
    const retry = (replyText, failure) => {
        messages.splice(base);
        messages.push({ role: 'assistant', content: replyText }, { role: 'user', content: retryPrompt(check, failure, current()) });
    };
    let lastFailure = '';

    const changedFiles = () => {
        const changed = [];
        for (const [f, buf] of snapshot) {
            const now = existsSync(f) ? readFileSync(f, 'utf8') : null;
            const before = buf === null ? null : buf.toString('utf8');
            if (now !== before) changed.push({ path: f, created: before === null, ...lineDelta(before, now) });
        }
        return changed;
    };
    const lineTotals = (changed) => `+${changed.reduce((s, c) => s + c.added, 0)} -${changed.reduce((s, c) => s + c.removed, 0)} ` +
        `lines across ${changed.length} file${changed.length === 1 ? '' : 's'}`;

    // The tool loop's requests: same model and sampling as attempt 1, tools on, a smaller output budget.
    // After a runaway, later requests ask the server to skip thinking (loop_thinking auto; off always asks).
    let runawaySeen = false;
    const loopNoThinking = () => loopThinking === 'off' || (loopThinking === 'auto' && runawaySeen);
    // state.base: the steps' thinking budget, raised for the loop lane or seeded from the race, back to base once a
    // step makes an edit; cut-offs double it up to the step's output limit less room for the tool call.
    const loopChatFor = (state, { signal, say = log, base = loopThinkBudget } = {}) => async (msgs, { tools, maxTokens: limit, budgetScale = 1, thinkBudget: fixed = 0, deadline = 0 }) => {
        const room = state.base > base ? Math.max(limit, state.base + 4096) : limit;
        let reply;
        try {
            reply = await chat(key, { model, messages: msgs, maxTokens: room,
                sampling: samplingFor(model, temperature), tools, noThinking: loopNoThinking(), say,
                // deadline (the self-check's time limit) cancels the request in flight, not just the next one.
                signal: deadline ? AbortSignal.any([AbortSignal.timeout(Math.max(1, deadline - Date.now())), ...(signal ? [signal] : [])]) : signal,
                thinkBudget: fixed ? Math.min(fixed, room - 1024) : base && Math.min(state.base * budgetScale, Math.max(base, room - 1024)) });
        } catch (err) {
            if (err instanceof CancelledError && err.usage) countReply({ usage: err.usage });
            throw err;
        }
        if (reply.toolCalls?.some((c) => c.name === 'edit')) state.base = base;
        requests++;
        total.in += reply.usage.in;
        total.out += reply.usage.out;
        say(`    timing: ${timingText(reply.timing)}`);
        return reply;
    };
    const seqLoop = { base: loopThinkBudget };
    const loopChat = loopChatFor(seqLoop);
    // verify steps get a fixed thinking budget from runLoop (verifyThink), not the short loop budget.
    const verifyChat = loopChatFor({ base: 0 }, { base: 0 });
    // history: continue that conversation (a winning one-shot attempt's) instead of starting one; the task is already
    // in it, so the user turn holds the tool instructions, the files as they are now and the lead.
    const loopRun = (mode, lead, steps, history = null) => runLoop({
        chat: mode === 'verify' ? verifyChat : loopChat, files, readable: [...files, ...(args.context_files || []).map((p) => resolve(p))], cwd, mode,
        runCheck: () => runCheck(check, cwd, checkTimeout), runNode: (code) => runNode(code, cwd), log,
        maxSteps: steps, maxTokens: mode === 'verify' ? LANE_MAX_TOKENS : loopMaxTokens, onRunaway: () => { runawaySeen = true; }, system: mode === 'verify' ? VERIFY_SYSTEM : FIX_SYSTEM,
        ...(history ? { history } : {}), verifyThink: VERIFY_THINK_BUDGET, verifyMs: verifyMs,
        user: history
            ? `Your edits were applied and the check passes. From here you work through tools (no more file blocks).\n\n` +
                `${mode === 'verify' ? VERIFY_SYSTEM : FIX_SYSTEM}\n\nFiles you may change, as they are now:${current()}\n\n` +
                `Working directory: ${cwd}\nCheck command: ${check}\n\n${lead}`
            : `${args.prompt}${contextText}\n\nFiles you may change, as they are now:${current()}\n\n` +
                `Working directory: ${cwd}\nCheck command: ${check}\n\n${lead}`,
    });

    const countReply = (reply) => {
        requests++;
        total.in += reply.usage.in;
        total.out += reply.usage.out;
    };
    const originals = current();

    // One first attempt, for the parallel race: its own copy of the history, its own free retries. wrap (an
    // AbortSignal) cuts the attempt's thinking off now, as its budget would.
    const oneShot = async (temp, signal, tag, budget = thinkBudget, cap = maxTokens, wrap = undefined) => {
        const msgs = messages.slice(0, base);
        const sampling = samplingFor(model, temp);
        let free = 0;
        let thought = 0; // reasoning tokens across its tries
        for (;;) {
            let reply;
            try {
                // Budgeted on every try: an attempt that keeps thinking past it is dropped as a miss, since an unbudgeted try can stall the race.
                // A reissue after a cut-off only has to write, so it gets the short budget; the wrap cuts one request, not the reissue after it.
                reply = await chat(key, { model, messages: msgs, maxTokens: cap, attempt: 1, sampling,
                    thinkBudget: free ? Math.min(budget, thinkBudget) : budget, noThinking: free > 0, signal, say: (t) => log(t.replace('--- ', `--- ${tag} `)),
                    wrap: wrap?.aborted ? undefined : wrap });
            } catch (err) {
                if (!(err instanceof CancelledError)) throw err;
                if (err.usage) countReply({ usage: err.usage });
                log(`--- ${tag} cancelled: another attempt passed${err.usage ? ` (~${err.usage.out} tokens generated)` : ''}`);
                return { cancelled: true };
            }
            countReply(reply);
            thought += reply.usage.reasoning || 0;
            log(`\n--- ${tag} reply${free ? ` (after ${free} free retr${free === 1 ? 'y' : 'ies'})` : ''} (${reply.usage.in} in / ` +
                `${reply.usage.out} out, ${reply.usage.reasoning} reasoning, finish ${reply.finish}, temperature ${temp})\n${reply.text}`);
            log(`    timing: ${timingText(reply.timing)}`);
            if (reply.finish === 'think_budget') {
                runawaySeen = true;
                const why = wrap?.aborted ? 'the other attempts are out: cut off' : `thinking passed the ${free ? Math.min(budget, thinkBudget) : budget}-token budget`;
                if (free >= RACE_FREE_RETRIES) {
                    log(`--- ${tag} ${why} with nothing written again; dropped`);
                    return { reply, thought, error: 'kept thinking past its budget; nothing written.' };
                }
                free++;
                log(`--- ${tag} ${why} with nothing written; reissued to write its edits now (free retry ${free} of ${RACE_FREE_RETRIES})`);
                msgs.push({ role: 'user', content: budgetPrompt(reply.reasoningText, true) });
                continue;
            }
            // No runaway retries in the race: an attempt that spent its output on thinking (cut off, or a normal stop
            // with nothing usable after a long think) is out, and the others or the loop carry on.
            if (isRunaway(reply, true, cap)) {
                runawaySeen = true;
                log(`--- ${tag} runaway thinking (${reply.usage.reasoning} tokens, nothing usable); dropped`);
                return { reply, thought, error: 'spent its output on thinking; nothing written.' };
            }
            if (reply.finish === 'length') return { reply, thought, error: 'reply was cut off at max_tokens; nothing written.' };
            try {
                const { plan, summary } = planFiles(reply.text, files, '');
                return { reply, thought, plan, summary: summary.replace(/\n\([^\n]*\)$/, ''), history: msgs };
            } catch (err) {
                log(`--- ${tag} reply could not be applied\n${err.message}`);
                return { reply, thought, error: `reply could not be applied: ${err.message}` };
            }
        }
    };

    // The check command, pointed at a copy of the tree when it names the real one.
    const checkIn = (dir) => [cwd, cwd.replace(/\\/g, '/')].reduce((c, from) => c.split(from).join(dir), check);

    // Parallel first attempts, each written to its own copy of the tree and checked there as soon as its reply
    // is in. The first to pass wins and the others are cancelled. Returns null when the tree cannot be copied.
    const raceAttempts = async () => {
        const temps = Array.from({ length: parallel }, (_, i) =>
            i === 0 && temperature !== undefined ? temperature : PARALLEL_TEMPERATURES[i % PARALLEL_TEMPERATURES.length]);
        const t0 = performance.now();
        let first;
        try {
            first = await makeCopy(cwd);
        } catch (err) {
            if (!(err instanceof CantCopyError)) throw err;
            log(`=== parallel attempts off: ${err.message}; one attempt`);
            return null;
        }
        const budgets = temps.map((_, i) => thinkBudget * PORTFOLIO_SCALES[i % PORTFOLIO_SCALES.length]);
        const caps = budgets.map((b) => (!thinkBudget || b === thinkBudget ? maxTokens : Math.max(maxTokens, Math.min(b + maxTokens, RACE_MAX_TOKENS))));
        log(`\n=== ${parallel} parallel first attempt${parallel === 1 ? '' : 's'} (temperatures ${temps.join(', ')}; thinking budgets ` +
            `${budgets.map((b) => (b ? b : 'none')).join(', ')}; output caps ${caps.join(', ')}); first copy of the tree in ` +
            `${Math.round(performance.now() - t0)} ms`);
        const copies = temps.map((_, i) => (i === 0 ? Promise.resolve(first) : makeCopy(cwd)));
        copies.forEach((c) => c.catch(() => {}));
        const ctls = temps.map(() => new AbortController());
        // Once every other attempt is out without a pass, the last one still thinking is cut off and told to write
        // its edits now: nothing is left to race against, so the loop should not wait on its long budget.
        const wraps = temps.map(() => new AbortController());
        const thinking = new Set(temps.map((_, i) => i));
        const checks = limiter(Math.max(1, Math.min(temps.length + (loopLane ? 1 : 0), availableParallelism())));
        let winner = null;
        let out = 0;
        const leaves = (i) => {
            thinking.delete(i);
            // With the loop lane racing, nothing waits on the last attempt: let it use its budget.
            if (loopLane || winner !== null || ++out !== temps.length - 1) return;
            for (const j of thinking) {
                log(`=== [a${j + 1}] the other attempts are out; cutting its thinking off so it writes its edits now`);
                wraps[j].abort();
            }
        };
        const runOne = async (i) => {
            const tag = `[a${i + 1}]`;
            let shot;
            try {
                shot = await oneShot(temps[i], ctls[i].signal, tag, budgets[i], caps[i], wraps[i].signal);
            } catch (err) {
                return { i, temp: temps[i], apiError: err, score: 1e9 };
            } finally {
                thinking.delete(i);
            }
            if (shot.cancelled || winner !== null) return { i, temp: temps[i], ...shot, cancelled: true, score: 1e9 };
            if (!shot.plan) return { i, temp: temps[i], ...shot, score: 1e9 };
            const copy = await copies[i];
            withLockRetry(() => writePlan(shot.plan, copy.to));
            const ran = await checks(() => runCheck(checkIn(copy.dir), copy.dir, checkTimeout, ctls[i].signal));
            if (ran.cancelled) return { i, temp: temps[i], ...shot, cancelled: true, score: 1e9 };
            log(`--- ${tag} check ${ran.ok ? 'passed' : ran.timedOut ? 'timed out' : `failed (exit ${ran.code})`} in ${ran.ms} ms ` +
                `(in a copy of the tree)\n${tail(ran.output, 20000)}`);
            if (ran.ok && winner === null) {
                winner = i;
                ctls.forEach((c, j) => j !== i && c.abort());
                laneCtl.abort();
            }
            return { i, temp: temps[i], ...shot, ran, score: ran.ok ? 0 : failCount(ran.output) };
        };

        // The loop lane: the tool loop from the original files, in its own copy, from t=0; it does not wait for the
        // attempts to miss, and the first lane whose check passes wins. Returns { res, contents }, { cancelled }, or { error }.
        const laneCtl = new AbortController();
        const runLane = async () => {
            const signal = laneCtl.signal;
            let copy;
            try {
                copy = await makeCopy(cwd);
            } catch (err) {
                log(`=== [loop] no copy of the tree: ${err.message}`);
                return { error: err };
            }
            const say = (t) => log(t.replace(/^(\n*)/, '$1[loop] '));
            try {
                const laneFiles = files.map(copy.to);
                const seen = [...laneFiles, ...(args.context_files || []).map((p) => resolve(p)).map((p) => (inside(cwd, p) ? copy.to(p) : p))];
                const now = laneFiles.map((f) => (existsSync(f) ? fence(f, readFileSync(f, 'utf8')) : `\n\nFile: ${f}\n(does not exist yet)`)).join('');
                const laneCheck = checkIn(copy.dir);
                const res = await runLoop({
                    chat: loopChatFor({ base: 0 }, { signal, say, base: 0 }), files: laneFiles,
                    readable: seen, cwd: copy.dir, mode: 'fix', log: say, maxSteps, maxTokens: LANE_MAX_TOKENS,
                    ...(verify ? { selfCheck: { steps: Math.min(maxSteps, VERIFY_STEPS) }, verifyThink: VERIFY_THINK_BUDGET, verifyMs } : {}),
                    runCheck: () => checks(() => runCheck(laneCheck, copy.dir, checkTimeout, signal)),
                    runNode: (code) => runNode(code, copy.dir, signal, [cwd]), onRunaway: () => { runawaySeen = true; }, system: FIX_SYSTEM,
                    user: `${args.prompt}${contextText}\n\nFiles you may change, as they are now:${now}\n\nWorking directory: ${copy.dir}\n` +
                        `Check command: ${laneCheck}\n\nMake the change with the tools: read what you need, edit, run the check, ` +
                        'and call done when it passes.',
                });
                if (signal.aborted) return { cancelled: true };
                const contents = res.passed ? new Map(files.map((f) => {
                    const c = copy.to(f);
                    return [f, existsSync(c) ? readFileSync(c) : null];
                })) : null;
                say(`--- loop lane ${res.passed ? `passed at step ${res.steps}` : `out of steps after ${res.steps}`} (in a copy of the tree)`);
                return { res, contents };
            } catch (err) {
                if (err instanceof CancelledError || signal.aborted) return { cancelled: true };
                say(`--- loop lane stopped: ${err.message}`);
                return { error: err };
            } finally {
                copy.cleanup().catch(() => {});
            }
        };
        const lanePromise = loopLane ? runLane().then((r) => {
            if (r.contents && winner === null) {
                winner = 'loop';
                ctls.forEach((c) => c.abort());
            } else if (r.cancelled) log('--- [loop] cancelled: a one-shot attempt passed');
            return r;
        }) : Promise.resolve(null);
        if (loopLane) log(`=== the loop lane races them from the start, in its own copy (up to ${maxSteps} steps; ` +
            `no thinking budget, ${LANE_MAX_TOKENS}-token output cap)`);

        const [results, lane] = await Promise.all([Promise.all(temps.map((_, i) => runOne(i).then((r) => {
            if (r.score !== 0) leaves(i);
            return r;
        }))), lanePromise]);
        // Copies are removed in the background; nothing waits for it.
        copies.forEach((c) => c.then((x) => x.cleanup(), () => {}));
        const errors = results.filter((r) => r.apiError);
        if (errors.length === results.length && (!lane || lane.error)) throw errors[0].apiError;
        return { results, winner: typeof winner === 'number' ? winner : null, laneWon: winner === 'loop', lane, temps };
    };

    let free = 0;
    let steps = 0;
    let passed = null;
    let attemptsMade = maxAttempts;
    let laneSelfCheck = null; // the lane's own self-check, when it won with verify on
    let shotHistory = null; // the winning one-shot attempt's conversation, ending with its reply (verify continues it)
    try {
        const raced = loop && files.every((f) => inside(cwd, f)) ? await raceAttempts() : null;
        if (loop && !raced) log('=== one first attempt');
        const laneDone = !!(raced?.lane && !raced.lane.cancelled);
        if (raced?.lane?.res) steps += raced.lane.res.steps;
        if (raced?.laneWon) {
            attemptsMade = raced.results.length;
            const { res, contents } = raced.lane;
            for (const [f, buf] of contents) {
                if (buf === null) rmSync(f, { force: true });
                else {
                    mkdirSync(dirname(f), { recursive: true });
                    withLockRetry(() => writeFileSync(f, buf));
                }
            }
            const ran = await runCheck(check, cwd, checkTimeout);
            log(`--- [loop] applied to the real files; check ${ran.ok ? 'passed' : `failed (exit ${ran.code})`} in ${ran.ms} ms`);
            if (ran.ok) {
                laneSelfCheck = res.selfCheck || null;
                const fixSteps = res.steps - (res.selfCheck?.steps || 0);
                passed = { attempts: attemptsMade, loop: true, head: `check passed in the tool loop at step ${fixSteps} of ${maxSteps}, ` +
                    `racing ${attemptsMade} one-shot attempt${attemptsMade === 1 ? '' : 's'} from the start: ${check}${res.summary ? `\n${res.summary}` : ''}` };
            } else {
                lastFailure = `check failed (exit ${ran.code}) in the real tree, though it passed in a copy:\n${tail(ran.output, CHECK_OUTPUT_CHARS)}`;
            }
        } else if (raced) {
            attemptsMade = raced.results.length;
            const won = raced.winner !== null ? raced.results[raced.winner] : null;
            // No winner: the closest attempt seeds the loop, the one that thought longest breaking ties; the loop's first
            // step then gets a thinking budget near what the longest thinker used.
            const live = raced.results.filter((r) => !r.cancelled);
            const best = won || [...live].sort((a, b) => a.score - b.score || (b.thought || 0) - (a.thought || 0) || a.i - b.i)[0];
            if (!won) {
                // What an attempt that finished its thinking (and wrote edits) used; if none did, the most any spent.
                const finished = live.filter((r) => r.plan);
                const need = Math.max(0, ...(finished.length ? finished : live).map((r) => r.thought || 0));
                if (loopThinkBudget && need > loopThinkBudget) {
                    seqLoop.base = need;
                    log(`=== the loop's first step gets a ${need}-token thinking budget (what the longest-thinking attempt used)`);
                }
            }
            // With the loop lane finished and no winner, nothing more runs: the real files stay untouched.
            if (best?.plan && (won || !laneDone)) withLockRetry(() => writePlan(best.plan));
            if (won) {
                // Confirm in the real tree: it differs from the copy in .git and anything the check leaves behind.
                const ran = await runCheck(check, cwd, checkTimeout);
                log(`--- [a${won.i + 1}] applied to the real files; check ${ran.ok ? 'passed' : `failed (exit ${ran.code})`} in ${ran.ms} ms`);
                if (ran.ok) {
                    const r = won.reply.reasoningText?.trim();
                    shotHistory = won.history && [...won.history,
                        { role: 'assistant', content: won.reply.text || '', ...(r ? { reasoning_content: r } : {}) }];
                    passed = { attempts: attemptsMade, loop: false, head: `check passed on parallel attempt ${won.i + 1} of ` +
                        `${attemptsMade} (temperature ${won.temp}): ${check}\n${won.summary}` };
                } else {
                    lastFailure = `check failed (exit ${ran.code}) in the real tree, though it passed in a copy:\n${tail(ran.output, CHECK_OUTPUT_CHARS)}`;
                }
            } else if (best?.ran) {
                const why = best.ran.timedOut ? `timed out after ${checkTimeout}s` : `failed (exit ${best.ran.code})`;
                log(laneDone
                    ? `=== no parallel attempt passed and the loop lane is out of steps; [a${best.i + 1}] was closest (${best.score < 1e6 ? `${best.score} failing` : 'failing'})`
                    : `=== no parallel attempt passed; the loop starts from [a${best.i + 1}] (${best.score < 1e6 ? `${best.score} failing` : 'failing'})`);
                lastFailure = `check ${why}:\n${tail(best.ran.output, CHECK_OUTPUT_CHARS)}`;
            } else {
                lastFailure = best?.error || 'no attempt produced a usable reply';
            }
        }
        for (let attempt = 1; !raced && attempt <= maxAttempts; attempt++) {
            const temp = temperatureFor(attempt);
            const sampling = samplingFor(model, temp);
            // A cut-off or runaway reply is reissued at most MAX_FREE_RETRIES times with a budget; after that the
            // request runs to max_tokens, so the call always gets a real reply.
            const reply = await chat(key, { model, messages, maxTokens, attempt: check ? attempt : 0, sampling,
                thinkBudget: free < MAX_FREE_RETRIES ? thinkBudget : 0, noThinking: free > 0, say: log });
            requests++;
            total.in += reply.usage.in;
            total.out += reply.usage.out;
            const stats = statsFor();
            const done = (text, changed = []) => ({ ok: true, text, attempts: attempt, usage: { ...total }, files: changed });
            log(`\n--- attempt ${attempt}${free ? ` (after ${free} free retr${free === 1 ? 'y' : 'ies'})` : ''}: reply ` +
                `(${reply.usage.in} in / ${reply.usage.out} out, ${reply.usage.reasoning} reasoning, finish ${reply.finish}, ` +
                `temperature ${sampling.temperature ?? 'default'})\n${reply.text}`);
            log(`    timing: ${timingText(reply.timing)}`);

            if (reply.finish === 'think_budget') {
                free++;
                runawaySeen = true;
                log(`--- attempt ${attempt}: thinking passed the ${thinkBudget}-token budget with nothing written; cut off, ` +
                    `free retry ${free} of ${MAX_FREE_RETRIES}`);
                messages.push({ role: 'user', content: budgetPrompt(reply.reasoningText, files.length > 0) });
                attempt--;
                continue;
            }

            if (isRunaway(reply, files.length > 0, maxTokens) && free < MAX_FREE_RETRIES) {
                free++;
                runawaySeen = true;
                log(`--- attempt ${attempt}: runaway thinking; free retry ${free} of ${MAX_FREE_RETRIES}`);
                messages.push({ role: 'user', content: runawayPrompt(reply.usage.out, files.length > 0) });
                attempt--;
                continue;
            }
            if (reply.finish === 'length') {
                lastFailure = `reply was cut off at max_tokens (${stats}); nothing written.`;
                if (!check) throw new Error(`Reply was cut off at max_tokens (${stats}); nothing written. Split the task or raise max_tokens.`);
                retry(reply.text, isRunaway(reply, true) ? runawayPrompt(reply.usage.out, true) : cutOffPrompt(reply.usage.out));
                continue;
            }
            if (!files.length && !args.output_file) return done(`${reply.text.trim()}\n\n(${stats})`);
            if (!files.length) {
                const out = resolve(args.output_file);
                if (!unfence(reply.text)) throw new Error(`Reply was empty (${stats}); nothing written to ${out}.`);
                const body = unfence(reply.text) + '\n';
                mkdirSync(dirname(out), { recursive: true });
                writeFileSync(out, body);
                return done(`Wrote ${body.split('\n').length - 1} lines to ${out} (${stats}).`);
            }

            let summary;
            try {
                summary = writeFiles(reply.text, files, stats);
            } catch (err) {
                // writeFiles wrote nothing, so the files are still as the previous attempt left them.
                log(`--- attempt ${attempt}: reply could not be applied\n${err.message}`);
                if (!check) throw err;
                lastFailure = `reply could not be applied: ${err.message}`;
                retry(reply.text, `Your reply could not be applied:\n${err.message}`);
                continue;
            }
            if (!check) return done(summary, changedFiles());

            const ran = await runCheck(check, cwd, checkTimeout);
            log(`--- attempt ${attempt}: check ${ran.ok ? 'passed' : ran.timedOut ? 'timed out' : `failed (exit ${ran.code})`}\n${tail(ran.output, 20000)}`);
            if (ran.ok) {
                passed = { attempts: attempt, loop: false, head: `check passed on attempt ${attempt} of ${maxAttempts}: ${check}\n` +
                    summary.replace(/\n\([^\n]*\)$/, '') };
                break;
            }
            const why = ran.timedOut ? `timed out after ${checkTimeout}s` : `failed (exit ${ran.code})`;
            const output = tail(ran.output, CHECK_OUTPUT_CHARS);
            lastFailure = `check ${why}:\n${output}`;
            retry(reply.text, `Your edits were written and \`${check}\` ${why}. Output:\n\`\`\`\n${output}\n\`\`\``);
        }

        if (!passed && laneDone && !raced.laneWon) {
            // The loop lane already ran its steps alongside the attempts: no second loop.
            const lane = raced.lane;
            if (lane.res?.lastOutput) lastFailure = `check ${tail(lane.res.lastOutput, CHECK_OUTPUT_CHARS)}`;
            else if (lane.error) lastFailure = `${lastFailure ? `${lastFailure}\n` : ''}the loop lane stopped: ${lane.error.message}`;
            log('=== no lane passed: neither the one-shot attempts nor the loop lane');
        } else if (!passed && loop) {
            log(`\n=== attempt 1 missed; switching to the tool loop (up to ${maxSteps} steps)`);
            const res = await loopRun('fix', `${attemptsMade > 1 ? `None of ${attemptsMade} one-shot attempts passed; the files hold the best one.`
                : 'Your one-shot attempt did not pass.'} Last ${lastFailure}\n\n` +
                'Find the cause and fix it with the tools until the check passes, then call done.', maxSteps);
            steps += res.steps;
            if (res.passed) {
                passed = { attempts: attemptsMade, loop: true, head: `check passed in the tool loop at step ${res.steps} of ${maxSteps} ` +
                    `(${attemptsMade > 1 ? `${attemptsMade} parallel attempts` : 'attempt 1'} missed): ${check}${res.summary ? `\n${res.summary}` : ''}` };
            } else {
                // The loop's own last check run, if it ran one; otherwise the one-shot failure still stands.
                if (res.lastOutput) lastFailure = `check ${tail(res.lastOutput, CHECK_OUTPUT_CHARS)}`;
            }
        }
    } catch (err) {
        // A request that failed half way must not leave half-made edits behind.
        restore();
        log(`=== stopped: ${err.message}; every file restored`);
        throw err;
    }

    if (!passed) {
        restore();
        const tried = `${attemptsMade} attempt${attemptsMade === 1 ? '' : 's'}${steps ? ` and ${steps} tool-loop steps` : ''}`;
        log(`=== gave up after ${tried}; every file restored`);
        return {
            ok: false,
            text: `check did not pass in ${tried}; every file is back as it was. Last ${lastFailure}\n(${statsFor()})\n` +
                FALLBACK_HINT,
            fallback: 'opencode',
            attempts: attemptsMade,
            ...(steps ? { steps } : {}),
            usage: { ...total },
            files: [],
        };
    }

    // Optional verify step, as OpenCode's agent does it unprompted: once the check passes, a short tool loop tests
    // the rules of the task and spec that the tests miss (asserts run with run_node) and fixes what breaks them.
    let verifyNote = '';
    let verified; // true: the self-check finished; false: it ran out of steps or failed; undefined: not run
    if (verify && laneSelfCheck) {
        // The winning lane already ran the self-check in its own conversation (its edits are in the files just applied).
        const sc = laneSelfCheck;
        const said = sc.summary ? `: ${sc.summary}` : '';
        const nEdits = `${sc.edits} edit${sc.edits === 1 ? '' : 's'}`;
        verified = sc.finished;
        verifyNote = sc.finished
            ? (sc.edits ? `verify: fixed: the self-check found a problem; ${nEdits}, and the check still passes${said}`
                : `verify: passed: the model's self-check found nothing to fix${said}`)
            : `verify: incomplete: the self-check ran out of ${sc.timedOut ? 'time' : 'steps'}${sc.undone ? '; its changes failed the check and were undone'
                : sc.edits ? `; kept its ${nEdits}, since the check still passes` : ''}`;
        log(`=== ${verifyNote} (in the loop lane's conversation, ${sc.steps} step${sc.steps === 1 ? '' : 's'})`);
    } else if (verify) {
        const good = new Map(files.map((f) => [f, existsSync(f) ? readFileSync(f) : null]));
        const cap = Math.min(maxSteps, VERIFY_STEPS);
        log(`
=== verify: self-check in the tool loop (up to ${cap} steps, ${Math.round(verifyMs / 1000)} s, ${VERIFY_THINK_BUDGET}-token thinking per step)${shotHistory ? ', continuing the winning attempt\'s conversation' : ''}`);
        // After a one-shot win, the self-check goes on in that attempt's conversation: it keeps its analysis and the
        // cached prompt, instead of re-reading the code first.
        const res = await loopRun('verify', 'The check passes with the files above. Test the rules of the task and its spec ' +
            'that the tests miss, as your instructions say, fix what breaks them, then call done.', cap, shotHistory)
            .catch((err) => ({ finished: false, steps: 0, edits: 0, error: err.message }));
        steps += res.steps;
        const said = res.summary ? `: ${res.summary}` : '';
        const nEdits = `${res.edits} edit${res.edits === 1 ? '' : 's'}`;
        if (res.finished) {
            verified = true;
            verifyNote = res.edits
                ? `verify: fixed: the self-check found a problem; ${nEdits}, and the check still passes${said}`
                : `verify: passed: the model's self-check found nothing to fix${said}`;
        } else {
            verified = false;
            const why = res.error ? ` (${res.error})` : '';
            // After an error the edit count is lost (res.edits is 0), so the check runs again then too.
            const stillOk = (!res.edits && !res.error) || (await runCheck(check, cwd, checkTimeout)).ok;
            if (stillOk) {
                verifyNote = `verify: incomplete${why}: the self-check ran out of ${res.timedOut ? 'time' : 'steps'}${res.edits ? `; kept its ${nEdits}, since the check still passes` : ''}`;
            } else {
                for (const [f, buf] of good) {
                    if (buf === null) rmSync(f, { force: true });
                    else withLockRetry(() => writeFileSync(f, buf));
                }
                verifyNote = `verify: incomplete${why}: the self-check ran out of ${res.timedOut ? 'time' : 'steps'} with the check failing; its changes were undone, ` +
                    'so the files are as they were when the check passed';
            }
        }
        log(`=== ${verifyNote}`);
    }
    const changed = changedFiles();
    const body = passed.loop || verify
        // After a one-shot pass, its own per-file summary is stale once verify has edited: list the files afresh.
        ? `${passed.loop ? passed.head : passed.head.split('\n')[0]}\n${changed.map((c) => `${c.created ? 'created' : 'edited'} ${c.path} (+${c.added} -${c.removed})`).join('\n')}`
        : passed.head;
    // A self-check that did not finish is still a success: the files pass the check (its edits were undone if they
    // broke it). verified: false says the extra review is unfinished, but there is no fallback: the check passed.
    return { ok: true, attempts: passed.attempts, ...(steps ? { steps } : {}), usage: { ...total }, files: changed,
        ...(verified !== undefined ? { verified } : {}),
        text: `${body}${verifyNote ? `\n${verifyNote}` : ''}\n${lineTotals(changed)}\n(${statsFor()})` };
}
