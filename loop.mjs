// The tool loop: after a one-shot attempt misses, the model works like a small coding agent with five tools
// (read_file, edit, run_check, run_node, done) until the check passes or the step cap is reached. It is also
// used for the optional verify step, where the model tests the spec rules the check does not cover.

import { readFileSync, existsSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { matchAllowed, readText, writeText, replaceOnce } from './edits.mjs';

const OUTPUT_CHARS = 4000;
const READ_LINES = 400;
const READ_CHARS = 20000;
// Old tool results are cut down before each request: resending them in full on every step is what makes agent loops expensive.
const KEEP_FULL = 4;
// The server caches prompt prefixes, and trimming rewrites history: wait until TRIM_AT results are whole, then trim
// back to KEEP_FULL, so the prefix changes once every few steps, not every step.
const TRIM_AT = 8;
const TRIMMED = '\n[...older output trimmed]';
const OLD_RESULT_CHARS = 300;
const OLD_ARGS_CHARS = 1500;
// A model that keeps answering in prose instead of calling tools is stopped after this many replies in a row.
const MAX_PROSE = 3;
// A step whose reasoning took more than this share of its output budget, without a tool call, is a runaway.
const RUNAWAY_SHARE = 0.9;

export const TOOLS = [
    {
        name: 'read_file',
        description: 'Read a file in the working directory, with line numbers ("12: text"). Use offset and limit for a ' +
            'part of a long file.',
        parameters: { type: 'object', properties: {
            path: { type: 'string', description: 'Path relative to the working directory, or absolute.' },
            offset: { type: 'integer', description: 'First line to show (1-based). Default 1.' },
            limit: { type: 'integer', description: `Lines to show. Default ${READ_LINES}.` },
        }, required: ['path'] },
    },
    {
        name: 'edit',
        description: 'Replace one piece of text in a file you may change. search must match one place in the current ' +
            'file (copy it from the file, without line numbers; small differences in indentation and spacing are ' +
            'tolerated). Keep each edit small: one change per call. To create a new allowed file, pass an empty search.',
        parameters: { type: 'object', properties: {
            path: { type: 'string', description: 'One of the files you may change.' },
            search: { type: 'string', description: 'The exact current text to replace (a few whole lines).' },
            replace: { type: 'string', description: 'The new text.' },
        }, required: ['path', 'search', 'replace'] },
    },
    {
        name: 'run_check',
        description: 'Run the check command (the tests) and get its output. Run it after your edits.',
        parameters: { type: 'object', properties: {} },
    },
    {
        name: 'run_node',
        description: 'Run a JavaScript snippet with Node as an ES module in the working directory, and get its output. ' +
            'Use it to see what the code really does: import a project file with a relative path such as ' +
            '"./src/x.js", call it, and console.log the result; or assert expected behaviour with node:assert. ' +
            'Snippets must not write files. They run sandboxed: no child processes, and no file access outside the working directory.',
        parameters: { type: 'object', properties: {
            code: { type: 'string', description: 'The ES module source to run.' },
        }, required: ['code'] },
    },
    {
        name: 'done',
        description: 'Finish. Accepted only when the check passes with your latest edits.',
        parameters: { type: 'object', properties: {
            summary: { type: 'string', description: 'One or two sentences on what you changed and why.' },
        }, required: ['summary'] },
    },
];

export const toolSchemas = () => TOOLS.map((t) => ({ type: 'function', function: t }));

const RULES = `How to work:
- Think briefly; prefer running code over long reasoning.
- Every reply calls one or more tools. Keep your thinking short: a few sentences, then act.
- Find causes by running code, not by rereading it: call run_node with a short snippet that imports the module
  and prints what the failing case returns. If you need to see inside a function, add a temporary console.error
  with edit, run it, and remove it afterwards.
- Fix with small edit calls whose search text is copied from the file as it is now.
- Run run_check after your edits. Call done when it passes.
- Never weaken, skip or delete a test, and never edit files outside the allowed list.`;

export const FIX_SYSTEM = `You fix code until a check command passes, working through tools.\n\n${RULES}`;

// verify: once the check passes, the model tests the spec rules the tests miss.
const VERIFY_STEPS_TEXT = `- Reread the task and the spec. Pick the rules the tests skip: edge cases, invalid inputs, exact error messages and
  values, every case the spec lists.
- Test them with run_node: import the module, check many cases in one snippet with node:assert/strict, and print each
  failure with its input, the expected and the actual value.
- For each failure, reread the spec text. If your assert contradicts the spec, the assert is wrong: fix it and run it
  again. Change the code only when it breaks a rule the spec states: send every edit that fix needs in one reply,
  followed by run_check in the same reply.
- Be brief: one or two run_node snippets that cover the rules, not a probe per rule. As soon as your asserts pass
  (and the check passes after any edit), call done. Aim to finish in three steps.`;
export const VERIFY_SYSTEM = `The check command already passes, but tests often miss rules the task and its spec state.
Test those rules yourself now, working through tools.

${RULES}
${VERIFY_STEPS_TEXT}`;
// The same step, continued in the fix loop's own conversation (selfCheck): it keeps its analysis and the cached prompt.
export const SELF_CHECK_PROMPT = `The check passes. Tests often miss rules the task and its spec state, so test those
rules yourself now before you finish:
${VERIFY_STEPS_TEXT}`;

function tail(text, n) {
    return text.length > n ? `[...${text.length - n} chars cut]\n${text.slice(-n)}` : text;
}

function numbered(text, from, to) {
    return text.split('\n').slice(from - 1, to).map((l, i) => `${from + i}: ${l}`).join('\n');
}

function trimHistory(messages) {
    const toolIdx = messages.map((m, i) => (m.role === 'tool' ? i : -1)).filter((i) => i >= 0);
    const whole = toolIdx.filter((i) => !messages[i].content.endsWith(TRIMMED)).length;
    if (whole <= TRIM_AT) return;
    const cutBefore = toolIdx[toolIdx.length - KEEP_FULL];
    for (let i = 0; i < cutBefore; i++) {
        const m = messages[i];
        if (m.role === 'tool' && m.content.length > OLD_RESULT_CHARS) {
            m.content = `${m.content.slice(0, OLD_RESULT_CHARS)}${TRIMMED}`;
        }
        // Older turns lose their reasoning in the same batch: later steps do not need it.
        if (m.role === 'assistant') delete m.reasoning_content;
        if (m.role === 'assistant' && m.tool_calls) {
            for (const c of m.tool_calls) {
                if (c.function.arguments.length <= OLD_ARGS_CHARS) continue;
                let args;
                try { args = JSON.parse(c.function.arguments); } catch { args = {}; }
                for (const k of Object.keys(args)) {
                    if (typeof args[k] === 'string' && args[k].length > 200) args[k] = `[${args[k].length} chars, trimmed from history]`;
                }
                c.function.arguments = JSON.stringify(args);
            }
        }
    }
}

// passed: the check passes as the files stand; finished: the model called done (or answered in prose) and it was accepted.
const READ_ONLY = new Set(['read_file', 'run_node']);
export const MAX_FREE_RUNAWAYS = 6;
// Self-check cost caps: each verify step thinks at most VERIFY_THINK_BUDGET tokens (a cut-off is nudged to act,
// without doubling), and the whole self-check stops after ctx.verifyMs. Its edits are kept if the check passes, else undone.
export const VERIFY_THINK_BUDGET = 4096;
export const VERIFY_MS = 90000;
// With this little of the time limit left, the model is told to call done now.
const VERIFY_NUDGE_MS = 25000;

// An assistant turn for the history: the reply's text plus its reasoning_content (the stream's second channel),
// so the next request carries the model's earlier analysis instead of making it start over.
function assistantTurn(reply, extra = {}) {
    const r = reply.reasoningText?.trim();
    return { role: 'assistant', content: reply.text || '', ...(r ? { reasoning_content: r } : {}), ...extra };
}

// ctx.selfCheck: { steps }: when the fix loop's done is accepted, the same conversation goes on with
// SELF_CHECK_PROMPT for up to that many more steps, instead of a fresh verify loop that re-derives the spec.
export async function runLoop(ctx) {
    // ctx.history: an earlier conversation to continue (a winning one-shot attempt's, ending with its reply); ctx.user
    // then follows it and carries the instructions, since ctx.system is not sent.
    const messages = ctx.history ? [...ctx.history, { role: 'user', content: ctx.user }]
        : [{ role: 'system', content: ctx.system }, { role: 'user', content: ctx.user }];
    let mode = ctx.mode;
    let limit = ctx.maxSteps;
    let fixEnd = null; // set once the fix part finished and the self-check began
    // The self-check's deadline (ctx.verifyMs from when verify mode starts); 0: no time limit.
    let verifyUntil = mode === 'verify' && ctx.verifyMs ? Date.now() + ctx.verifyMs : 0;
    let nudged = false;
    const inCwd = (abs, cwd = ctx.cwd) => {
        const rel = relative(cwd, abs);
        return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
    };
    const snapshot = () => new Map(ctx.files.map((f) => [f, existsSync(f) ? readFileSync(f) : null]));
    const sameBytes = (a, b) => (a === null || b === null ? a === b : a.equals(b));
    let edits = 0;
    let lastCheck = { ok: false, at: -1, output: '' };
    let probes = 0;
    let doneRefusals = 0;
    let prose = 0;
    let freeRunaways = 0;
    let cuts = 0; // budget cut-offs in a row: each doubles the next step's thinking budget

    const check = async () => {
        const ran = await ctx.runCheck();
        const why = ran.ok ? 'PASSED' : ran.timedOut ? 'TIMED OUT' : `FAILED (exit ${ran.code})`;
        lastCheck = { ok: ran.ok, at: edits, output: `${why}\n${ran.output}` };
        return `${why}\n${tail(ran.output, OUTPUT_CHARS)}`;
    };
    const passingNow = async () => (lastCheck.at === edits ? lastCheck.ok : (await check(), lastCheck.ok));

    const tools = {
        read_file({ path, offset, limit }) {
            if (typeof path !== 'string' || !path) return 'error: path is required';
            const abs = resolve(ctx.cwd, path);
            if (!inCwd(abs) && !ctx.readable.includes(abs)) return `error: ${path} is outside the working directory`;
            if (!existsSync(abs)) return `error: ${path} does not exist`;
            // The check above is on the path as written; a link inside the tree must not lead out of it.
            if (!ctx.readable.includes(abs) && !inCwd(realpathSync(abs), realpathSync(ctx.cwd))) {
                return `error: ${path} is outside the working directory`;
            }
            let text;
            try { text = readFileSync(abs, 'utf8'); } catch (err) { return `error: ${err.message}`; }
            text = text.replace(/\r\n/g, '\n');
            const total = text.split('\n').length;
            const from = Math.max(1, Number(offset) || 1);
            const to = Math.min(total, from + Math.max(1, Number(limit) || READ_LINES) - 1);
            let out = numbered(text, from, to);
            if (out.length > READ_CHARS) out = `${out.slice(0, READ_CHARS)}\n[...cut; read a smaller range]`;
            return `${out}\n(lines ${from}-${to} of ${total})`;
        },
        edit({ path, search, replace }) {
            if (typeof path !== 'string' || typeof search !== 'string' || typeof replace !== 'string') {
                return 'error: path, search and replace must all be strings';
            }
            const target = matchAllowed(resolve(ctx.cwd, path), ctx.files) || matchAllowed(path, ctx.files);
            if (!target) return `error: ${path} is not a file you may change. Allowed: ${ctx.files.join(', ')}`;
            const cur = readText(target);
            if (!cur) {
                if (search !== '') return `error: ${path} does not exist yet; create it with an empty search`;
                writeText(target, replace.endsWith('\n') ? replace : `${replace}\n`, false);
                edits++;
                return `created ${path}`;
            }
            // An empty search fills an empty file; on a file with text it would be ambiguous.
            if (search === '' && cur.text.trim()) return 'error: search is empty; copy the text to replace from the file';
            if (search === '') {
                writeText(target, replace.endsWith('\n') ? replace : `${replace}\n`, cur.crlf);
                edits++;
                return `filled ${path}`;
            }
            const res = replaceOnce(cur.text, search, replace);
            if (res.error) return `error: ${res.error}. Nothing changed. Read the file again and copy the search text exactly.`;
            writeText(target, res.content, cur.crlf);
            edits++;
            const at = res.content.slice(0, res.start).split('\n').length;
            const shown = Math.max(1, Math.min(replace.split('\n').length, 30));
            return `edited ${path}${res.how === 'exact' ? '' : ` (matched ${res.how})`}. Lines ${at}-${at + shown - 1} now:\n` +
                numbered(res.content, at, at + shown - 1);
        },
        async run_check() {
            return check();
        },
        async run_node({ code }) {
            if (typeof code !== 'string' || !code.trim()) return 'error: code is required';
            probes++;
            // A snippet may write in the tree: a change to a task file counts as an edit, so a stale check
            // result is not reused and the rollback sees it.
            const before = snapshot();
            const ran = await ctx.runNode(code);
            if (ctx.files.some((f) => !sameBytes(before.get(f), existsSync(f) ? readFileSync(f) : null))) {
                edits++;
                ctx.log('--- run_node changed a task file; counted as an edit');
            }
            const head = ran.timedOut ? 'TIMED OUT' : `exit ${ran.code}`;
            return `${head}\n${tail(ran.output, OUTPUT_CHARS) || '(no output)'}`;
        },
        async done({ summary }) {
            if (mode === 'verify' && !probes && doneRefusals++ === 0) {
                return 'not yet: first test the spec rules with run_node.';
            }
            if (await passingNow()) return { finished: true, summary: String(summary || ''), at: edits };
            return `not done: the check does not pass with your latest edits.\n${tail(lastCheck.output, OUTPUT_CHARS)}`;
        },
    };

    // done accepted: return, or (with selfCheck, the first time) switch to the self-check in this conversation.
    const finish = (step, summary) => {
        if (fixEnd) {
            return { passed: true, finished: true, steps: step, summary: fixEnd.summary, edits,
                selfCheck: { finished: true, steps: step - fixEnd.step, edits: edits - fixEnd.edits, summary } };
        }
        if (!ctx.selfCheck) return { passed: true, finished: true, steps: step, summary, edits };
        fixEnd = { step, edits, summary, snapshot: snapshot() };
        mode = 'verify';
        probes = 0;
        doneRefusals = 0;
        limit = step + ctx.selfCheck.steps;
        verifyUntil = ctx.verifyMs ? Date.now() + ctx.verifyMs : 0;
        nudged = false;
        messages.push({ role: 'user', content: SELF_CHECK_PROMPT });
        ctx.log(`--- fix finished at step ${step}; self-check in the same conversation (up to ${ctx.selfCheck.steps} steps)`);
        return null;
    };

    for (let step = 1; ; step++) {
        if (step > limit) {
            // Out of fix steps with the check passing counts as done for the self-check: the lane may pass without
            // calling done, and a fresh verify loop would re-derive the spec.
            if (!fixEnd && ctx.selfCheck && await passingNow()) finish(step - 1, '');
            else break;
        }
        const timeUp = async () => {
            ctx.log(`--- verify time limit reached (${Math.round(ctx.verifyMs / 1000)} s)`);
            if (fixEnd) return selfCheckOut(step - 1, true);
            const passed = await passingNow();
            return { passed, finished: false, timedOut: true, steps: step - 1, summary: '', lastOutput: lastCheck.output, edits };
        };
        if (mode === 'verify' && verifyUntil && Date.now() >= verifyUntil) return timeUp();
        trimHistory(messages);
        // verify steps get a fixed thinking budget (ctx.verifyThink), not doubled after a cut-off; the deadline
        // cancels a request still running when time is up.
        const deadline = mode === 'verify' ? verifyUntil : 0;
        let reply;
        try {
            reply = await ctx.chat(messages, { tools: toolSchemas(), maxTokens: ctx.maxTokens, ...(deadline ? { deadline } : {}),
                ...(mode === 'verify' && ctx.verifyThink ? { budgetScale: 1, thinkBudget: ctx.verifyThink } : { budgetScale: 2 ** cuts }) });
        } catch (err) {
            if (deadline && Date.now() >= deadline) return timeUp();
            throw err;
        }
        ctx.log(`\n--- ${mode} step ${step} of ${limit}: (${reply.usage.in} in / ${reply.usage.out} out, ` +
            `${reply.usage.reasoning} reasoning, finish ${reply.finish}, ${reply.toolCalls.length} tool call` +
            `${reply.toolCalls.length === 1 ? '' : 's'})${reply.text.trim() ? `\n${reply.text.trim()}` : ''}`);

        // A step that thought through its budget without calling a tool: nudge it to act. Runaways do not use up
        // steps (up to MAX_FREE_RUNAWAYS per loop); each cut-off doubles the next step's thinking budget until a tool call.
        const runaway = !reply.toolCalls.length && (reply.finish === 'length' || reply.finish === 'think_budget' ||
            reply.usage.reasoning > RUNAWAY_SHARE * (reply.limit ?? ctx.maxTokens));
        if (runaway) {
            ctx.onRunaway?.();
            // The analysis so far goes back as the turn's reasoning_content, whether the budget or the output limit
            // cut it off; the nudge itself stays short.
            messages.push(assistantTurn(reply),
                { role: 'user', content: 'Continue from your analysis above and make the next tool call now; keep reasoning brief.' });
            const free = freeRunaways < MAX_FREE_RUNAWAYS;
            if (free) freeRunaways++;
            if (reply.finish === 'think_budget') cuts++;
            ctx.log(`--- ${mode} step ${step}: runaway thinking; nudged` +
                `${free ? ` (free ${freeRunaways} of ${MAX_FREE_RUNAWAYS}: this step does not count)` : ''}` +
                `${reply.finish === 'think_budget' ? `; next thinking budget x${2 ** cuts}` : ''}`);
            if (free) step--;
            continue;
        }
        cuts = 0;
        if (!reply.toolCalls.length) {
            prose++;
            messages.push(assistantTurn(reply));
            // Plain text: the model thinks it is finished. Hold it to the same rule as done.
            const res = await tools.done({ summary: reply.text });
            ctx.log(`< (no tool call; treated as done) ${typeof res === 'string' ? res.split('\n')[0] : 'accepted'}`);
            if (typeof res !== 'string') {
                const out = finish(step, res.summary.trim());
                if (out) return out;
                prose = 0;
                continue;
            }
            if (prose >= MAX_PROSE) {
                ctx.log(`--- ${mode} loop stopped: ${prose} replies in a row without a tool call`);
                if (fixEnd) return selfCheckOut(step, false);
                return { passed: false, finished: false, steps: step, summary: '', lastOutput: lastCheck.output, edits };
            }
            messages.push({ role: 'user', content: `${res}\nAnswer with tool calls (edit, run_check, run_node), not prose.` });
            continue;
        }
        prose = 0;

        messages.push(assistantTurn(reply, {
            tool_calls: reply.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) }));
        let finished = null;
        const runCall = async (call) => {
            let args;
            try {
                args = call.arguments.trim() ? JSON.parse(call.arguments) : {};
            } catch (err) {
                return `error: the arguments are not valid JSON (${err.message}). Send the call again${reply.finish === 'length' ? ', shorter: the reply was cut off' : ''}.`;
            }
            const fn = tools[call.name];
            if (!fn) return `error: there is no tool named ${call.name}`;
            const t0 = performance.now();
            const result = await fn(args);
            took.set(call, Math.round(performance.now() - t0));
            return result;
        };
        const took = new Map();
        // Runs of read-only calls (read_file, run_node) go at once; edits, checks and done keep their order.
        const calls = reply.toolCalls;
        for (let i = 0; i < calls.length;) {
            let j = i + 1;
            if (READ_ONLY.has(calls[i].name)) while (j < calls.length && READ_ONLY.has(calls[j].name)) j++;
            const group = calls.slice(i, j);
            const results = await Promise.all(group.map(runCall));
            group.forEach((call, k) => {
                let result = results[k];
                if (typeof result !== 'string') {
                    finished = result;
                    result = 'accepted';
                }
                ctx.log(`> ${call.name}${took.has(call) ? ` (${took.get(call)} ms)` : ''} ${tail(call.arguments, 2000)}\n< ${tail(result, 4000)}`);
                messages.push({ role: 'tool', tool_call_id: call.id, content: result });
            });
            if (group.length > 1) ctx.log(`--- ${group.length} read-only calls ran at once`);
            i = j;
        }
        // done was checked against the files before any edit that came after it in the same reply.
        if (finished && finished.at !== edits) {
            finished = null;
            messages.push({ role: 'user', content: 'You changed files after calling done, so done was not accepted. ' +
                'Run the check, then call done again.' });
        }
        if (finished) {
            const out = finish(step, finished.summary);
            if (out) return out;
            continue;
        }
        // Nudge on the last verify step: the model may keep probing working code and never call done.
        if (mode === 'verify' && !nudged && step === limit - 1) {
            nudged = true;
            messages.push({ role: 'user', content: 'One step left. If your asserts pass and the check passes, call done now.' });
        } else if (mode === 'verify' && !nudged && verifyUntil && verifyUntil - Date.now() < VERIFY_NUDGE_MS) {
            nudged = true;
            messages.push({ role: 'user', content: 'Time is nearly up. If your asserts pass and the check passes, call done now.' });
        }
    }
    if (fixEnd) return selfCheckOut(limit, false);
    // Out of steps: the work still counts if the check passes as the files stand.
    const passed = await passingNow();
    ctx.log(`--- ${mode} loop out of steps; check ${passed ? 'passes' : 'still fails'}`);
    return { passed, finished: false, steps: limit, summary: '', lastOutput: lastCheck.output, edits };

    // The self-check stopped without done: keep its edits if the check still passes, else put the files back as they
    // were when the fix finished. Either way the fix itself passed.
    async function selfCheckOut(step, timedOut = false) {
        const ok = edits === fixEnd.edits || await passingNow();
        if (!ok) {
            for (const [f, buf] of fixEnd.snapshot) {
                if (buf === null) rmSync(f, { force: true });
                else writeFileSync(f, buf);
            }
        }
        ctx.log(`--- self-check out of ${timedOut ? 'time' : 'steps'}; ${ok ? 'check passes' : 'check failed, so its changes were undone'}`);
        return { passed: true, finished: true, steps: step, summary: fixEnd.summary, edits: ok ? edits : fixEnd.edits,
            selfCheck: { finished: false, steps: step - fixEnd.step, edits: edits - fixEnd.edits, undone: !ok, ...(timedOut ? { timedOut } : {}) } };
    }
}
