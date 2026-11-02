// The tool loop: after a missed one-shot attempt the model works through read_file, edit, run_check, run_node
// and done. Server-level tests drive it through the mock (streamed tool-call deltas included); unit tests
// call runLoop directly with a fake chat.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runLoop, FIX_SYSTEM, VERIFY_SYSTEM, SELF_CHECK_PROMPT } from '../loop.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const SERVER = resolve(here, '../warriorgpt-mcp.mjs');
const CLI = resolve(here, '../warriorgpt-ask.mjs');
const MOCK = pathToFileURL(join(here, 'mock-fetch.mjs')).href;

let dir;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'warriorgpt-loop-test-'));
});

function env(replies, extra = {}) {
    writeFileSync(join(dir, 'replies.json'), JSON.stringify(replies));
    const home = join(dir, 'home');
    mkdirSync(home, { recursive: true });
    return { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: home, WARRIORGPT_API_KEY: 'test-key',
        CLAUDE_CODE_SESSION_ID: 'test', MOCK_REPLIES: join(dir, 'replies.json'), MOCK_REQUEST: join(dir, 'request.json'),
        MOCK_REQUEST_LOG: join(dir, 'requests.jsonl'), ...extra };
}

function call(args, replies, extra) {
    const res = spawnSync(process.execPath, ['--import', MOCK, SERVER], {
        input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ask_warriorgpt', arguments: { parallel: 1, loop_lane: false, ...args } } }) + '\n',
        encoding: 'utf8', env: env(replies, extra),
    });
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout.trim().split('\n')[0]);
    return { text: out.result.content[0].text, isError: !!out.result.isError, structured: out.result.structuredContent };
}

const requests = () => readFileSync(join(dir, 'requests.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const block = (path, body) => `=== FILE: ${path} ===\n${body}\n=== END FILE ===`;
const edit = (search, replace) => `<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE`;
const tools = (...calls) => ({ tool_calls: calls.map(([name, args = {}]) => ({ name, arguments: args })) });

// one.txt starts as "start\nkeep\n"; the check passes only when it says "good".
function setup() {
    const one = join(dir, 'one.txt');
    writeFileSync(one, 'start\nkeep\n');
    writeFileSync(join(dir, 'check.mjs'), "import { readFileSync } from 'node:fs';\n" +
        "const t = readFileSync(new URL('./one.txt', import.meta.url), 'utf8');\n" +
        "if (!t.includes('good')) { console.log('one.txt is NOT GOOD: ' + t.trim()); process.exit(1); }\n");
    return { one, check: `"${process.execPath}" check.mjs` };
}

for (const streamed of [true, false]) {
    test(`loop: a missed first attempt switches to tools and passes (${streamed ? 'streamed' : 'not streamed'})`, () => {
        const { one, check } = setup();
        const { text, isError } = call({ prompt: 'make it good', files: [one], check }, [
            block(one, edit('start', 'bad')),
            tools(['read_file', { path: 'one.txt' }]),
            tools(['edit', { path: 'one.txt', search: 'bad', replace: 'good' }], ['run_check']),
            tools(['done', { summary: 'replaced bad with good' }]),
        ], streamed ? { MOCK_STREAM: '1' } : {});
        assert.equal(isError, false, text);
        assert.match(text, /^check passed in the tool loop at step 3 of 30 \(attempt 1 missed\)/);
        assert.match(text, /replaced bad with good/);
        assert.match(text, /edited .*one\.txt \(\+1 -1\)/);
        assert.equal(readFileSync(one, 'utf8'), 'good\nkeep\n');

        const reqs = requests();
        assert.equal(reqs.length, 4);
        assert.equal(reqs[0].tools, undefined, 'the one-shot attempt has no tools');
        assert.deepEqual(reqs[1].tools.map((t) => t.function.name), ['read_file', 'edit', 'run_check', 'run_node', 'done']);
        assert.equal(reqs[1].stream, true);
        assert.equal(reqs[1].messages[0].content, FIX_SYSTEM);
        assert.match(reqs[1].messages[1].content, /make it good/);
        assert.match(reqs[1].messages[1].content, /one\.txt is NOT GOOD: bad/, 'the loop starts from the check output');
        assert.match(reqs[1].messages[1].content, /Check command: /);
        // The tool calls come back reassembled, and each gets its result.
        const asked = reqs[2].messages.at(-2);
        assert.equal(asked.role, 'assistant');
        assert.deepEqual(JSON.parse(asked.tool_calls[0].function.arguments), { path: 'one.txt' });
        assert.equal(reqs[2].messages.at(-1).role, 'tool');
        assert.equal(reqs[2].messages.at(-1).tool_call_id, asked.tool_calls[0].id);
        assert.match(reqs[2].messages.at(-1).content, /^1: bad\n2: keep/);
        assert.match(reqs[3].messages.at(-2).content, /^edited one\.txt\. Lines 1-1 now:\n1: good/);
        assert.match(reqs[3].messages.at(-1).content, /^PASSED/);
    });
}

test('loop: run_node runs a snippet with this Node in the working directory, with no shell', () => {
    const { one, check } = setup();
    const code = "import { readFileSync } from 'node:fs';\nconsole.log(process.execPath);\nconsole.log(process.cwd());\n" +
        "console.log('file says ' + readFileSync('./one.txt', 'utf8').split('\\n')[0]);\nconsole.log('a && b | c > d');";
    const { text, isError } = call({ prompt: 'x', files: [one], check }, [
        block(one, edit('start', 'bad')),
        tools(['run_node', { code }]),
        tools(['edit', { path: 'one.txt', search: 'bad', replace: 'good' }], ['done', { summary: 'ok' }]),
    ]);
    assert.equal(isError, false, text);
    const result = requests()[2].messages.at(-1).content;
    assert.match(result, /^exit 0\n/);
    assert.ok(result.toLowerCase().includes(process.execPath.toLowerCase()), result);
    assert.ok(result.toLowerCase().includes(dir.toLowerCase()), result);
    assert.match(result, /file says bad/);
    assert.match(result, /a && b \| c > d/, 'the snippet is not run through a shell');
});

test('loop: done is refused until the check passes; if it never does, every file is restored with steps reported', () => {
    const { one, check } = setup();
    const { text, isError, structured } = call({ prompt: 'x', files: [one], check, max_steps: 3 }, [
        block(one, edit('start', 'bad')),
        tools(['done', { summary: 'finished' }]),
        tools(['edit', { path: 'one.txt', search: 'bad', replace: 'worse' }]),
        tools(['done', { summary: 'finished now' }]),
    ]);
    assert.equal(isError, true);
    assert.deepEqual(structured, { ok: false, fallback: 'opencode', attempts: 1, steps: 3 });
    assert.match(text, /^check did not pass in 1 attempt and 3 tool-loop steps; every file is back as it was/);
    assert.match(text, /NOT GOOD: worse/);
    assert.match(text, /fallback: opencode/);
    assert.equal(readFileSync(one, 'utf8'), 'start\nkeep\n');
    const reqs = requests();
    assert.equal(reqs.length, 4);
    assert.match(reqs[2].messages.at(-1).content, /^not done: the check does not pass/);
});

test('loop: edits outside the allowed files and reads outside the working directory are refused', () => {
    const { one, check } = setup();
    const other = join(dir, 'other.txt');
    writeFileSync(other, 'leave me\n');
    const { text, isError } = call({ prompt: 'x', files: [one], check }, [
        block(one, edit('start', 'bad')),
        tools(['edit', { path: 'other.txt', search: 'leave me', replace: 'changed' }], ['read_file', { path: '../secret.txt' }],
            ['edit', { path: 'one.txt', search: 'nowhere', replace: 'x' }]),
        tools(['edit', { path: 'one.txt', search: 'bad', replace: 'good' }], ['done', { summary: 'ok' }]),
    ]);
    assert.equal(isError, false, text);
    const results = requests()[2].messages.slice(-3).map((m) => m.content);
    assert.match(results[0], /^error: other\.txt is not a file you may change/);
    assert.match(results[1], /^error: \.\.\/secret\.txt is outside the working directory/);
    assert.match(results[2], /^error: search text not found.*Nothing changed/);
    assert.equal(readFileSync(other, 'utf8'), 'leave me\n');
});

test('loop: an unparseable reply also starts the loop, and loop: false keeps the old retries', () => {
    const { one, check } = setup();
    const looped = call({ prompt: 'x', files: [one], check }, [
        'no file blocks here',
        tools(['edit', { path: 'one.txt', search: 'start', replace: 'good' }], ['done', { summary: 'ok' }]),
    ]);
    assert.equal(looped.isError, false, looped.text);
    assert.match(looped.text, /tool loop at step 1 of 30/);
    assert.match(requests()[1].messages[1].content, /could not be applied/);

    writeFileSync(one, 'start\nkeep\n');
    writeFileSync(join(dir, 'requests.jsonl'), '');
    const retried = call({ prompt: 'x', files: [one], check, loop: false }, [
        block(one, edit('start', 'bad')), block(one, edit('bad', 'good')),
    ]);
    assert.match(retried.text, /^check passed on attempt 2 of 3/);
    assert.ok(requests().every((r) => !r.tools));
});

test('loop: the CLI logs every step and reports steps in its JSON line; exit 4 when it never passes', () => {
    const { one, check } = setup();
    const log = join(dir, 'run.log');
    // --no-loop-lane: this test pins the old single flow (one-shot, then the loop), not the racing lane.
    const run = (args, replies) => spawnSync(process.execPath, ['--import', MOCK, CLI, '--prompt', 'x', '--files', one,
        '--check', check, '--parallel', '1', '--no-loop-lane', ...args], { encoding: 'utf8', env: env(replies) });
    const ok = run(['--log', log], [
        block(one, edit('start', 'bad')),
        tools(['run_check']),
        tools(['edit', { path: 'one.txt', search: 'bad', replace: 'good' }], ['done', { summary: 'fixed' }]),
    ]);
    assert.equal(ok.status, 0, ok.stderr);
    const json = JSON.parse(ok.stdout.trim().split('\n').at(-1));
    assert.equal(json.steps, 2);
    assert.equal(json.attempts, 1);
    const text = readFileSync(log, 'utf8');
    assert.match(text, /=== attempt 1 missed; switching to the tool loop \(up to 30 steps\)/);
    assert.match(text, /--- fix step 1 of 30: \(10 in \/ 20 out, 0 reasoning, finish tool_calls, 1 tool call\)/);
    assert.match(text, /> run_check \(\d+ ms\) \{\}\n< FAILED \(exit 1\)/);
    assert.match(text, /--- fix step 2 of 30: [^\n]*2 tool calls\)/);
    assert.match(text, /> done \(\d+ ms\) \{"summary":"fixed"\}\n< accepted/);

    writeFileSync(one, 'start\nkeep\n');
    const failed = run(['--max-steps', '2', '--json'], [block(one, edit('start', 'bad')), tools(['run_check'])]);
    assert.equal(failed.status, 4, failed.stderr);
    const fj = JSON.parse(failed.stdout.trim());
    assert.equal(fj.fallback, 'opencode');
    assert.equal(fj.steps, 2);
    assert.equal(readFileSync(one, 'utf8'), 'start\nkeep\n');
});

// --- runLoop on its own, with a fake chat.

function fakeCtx(replies, over = {}) {
    const seen = [];
    let n = 0;
    return {
        seen,
        ctx: {
            chat: async (messages) => {
                seen.push(structuredClone(messages));
                const r = replies[Math.min(n++, replies.length - 1)];
                return { text: r.text || '', finish: r.finish || (r.calls ? 'tool_calls' : 'stop'), reasoningText: r.reasoningText || '',
                    usage: { in: 1, out: r.out ?? 1, reasoning: r.reasoning ?? 0 },
                    toolCalls: (r.calls || []).map(([name, args], i) => ({ id: `c${n}_${i}`, name,
                        arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}) })) };
            },
            files: [], readable: [], cwd: dir, mode: 'fix', maxSteps: 10, maxTokens: 100, system: FIX_SYSTEM, user: 'task',
            runCheck: async () => ({ ok: false, code: 1, output: 'nope' }),
            runNode: async () => ({ ok: true, code: 0, output: 'x'.repeat(2000) }),
            log: () => {},
            ...over,
        },
    };
}

test('runLoop: old tool results and long old arguments are trimmed in batches; the last four stay whole', async () => {
    const long = `console.log(${JSON.stringify('y'.repeat(1800))})`;
    const { ctx, seen } = fakeCtx([{ calls: [['run_node', { code: long }]] }], { maxSteps: 11 });
    await runLoop(ctx);
    // Up to eight whole results nothing is rewritten, so the prompt prefix the server cached stays valid.
    for (const s of seen.slice(0, 9)) assert.ok(s.filter((m) => m.role === 'tool').every((m) => m.content.length > 2000));
    const last = seen.at(-1);
    const results = last.filter((m) => m.role === 'tool').map((m) => m.content);
    assert.equal(results.length, 10);
    for (const r of results.slice(0, 5)) assert.ok(r.length < 400 && r.endsWith('[...older output trimmed]'), r.length);
    for (const r of results.slice(5)) assert.ok(r.length > 2000);
    const calls = last.filter((m) => m.role === 'assistant').map((m) => JSON.parse(m.tool_calls[0].function.arguments).code);
    assert.equal(calls[0], `[${long.length} chars, trimmed from history]`);
    assert.equal(calls.at(-1), long);
});

test('runLoop: when the history is trimmed, the old assistant turns lose their reasoning_content; the newest keeps it', async () => {
    // One run_node call per step: nine whole results cross TRIM_AT (8), so the batch trims back to KEEP_FULL (4)
    // whole results; the cut falls just before the sixth tool result, so its calling turn goes with the older prefix.
    const replies = Array.from({ length: 11 }, (_, i) => ({ reasoningText: `thought ${i + 1}`,
        calls: [['run_node', { code: `c${i + 1}` }]] }));
    const { ctx, seen } = fakeCtx(replies, { maxSteps: 11 });
    await runLoop(ctx);
    const turns = seen.at(-1).filter((m) => m.role === 'assistant');
    assert.equal(turns.length, 10, 'ten steps ran before the eleventh request');
    turns.forEach((m, i) => {
        if (i < 6) assert.equal(m.reasoning_content, undefined, `turn ${i + 1} was trimmed`);
        else assert.equal(m.reasoning_content, `thought ${i + 1}`, `turn ${i + 1} kept its reasoning`);
    });
});

test('runLoop: a model that answers in prose is stopped after three replies', async () => {
    const { ctx, seen } = fakeCtx([{ text: 'I think it is fine now.' }]);
    const res = await runLoop(ctx);
    assert.equal(res.passed, false);
    assert.equal(res.steps, 3);
    assert.match(seen[1].at(-1).content, /^not done: the check does not pass[\s\S]*not prose/);
});

test('runLoop: prose is accepted as done when the check passes', async () => {
    const { ctx } = fakeCtx([{ text: 'Done.' }], { runCheck: async () => ({ ok: true, code: 0, output: 'ok' }) });
    const res = await runLoop(ctx);
    assert.equal(res.passed, true);
    assert.equal(res.steps, 1);
});

test('runLoop: a reply cut off while thinking gets a nudge; broken JSON arguments get an error result', async () => {
    const { ctx, seen } = fakeCtx([{ finish: 'length' }, { calls: [['run_check', '{"oops']] }, { calls: [['done', { summary: 's' }]] }],
        { maxSteps: 3 });
    const res = await runLoop(ctx);
    assert.equal(res.passed, false);
    // The cut-off step goes back as an assistant turn, followed by the short nudge.
    assert.equal(seen[1].at(-2).role, 'assistant');
    assert.equal(seen[1].at(-1).content, 'Continue from your analysis above and make the next tool call now; keep reasoning brief.');
    assert.match(seen[2].at(-1).content, /^error: the arguments are not valid JSON/);
});

test('runLoop: a step cut off at the output limit sends its analysis back with the nudge', async () => {
    const { ctx, seen } = fakeCtx([{ finish: 'length', reasoningText: 'THE PLAN: compare prerelease ids' }, { calls: [['done', { summary: 's' }]] }],
        { runCheck: async () => ({ ok: true, code: 0, output: 'ok' }) });
    const res = await runLoop(ctx);
    assert.equal(res.passed, true);
    // The analysis goes back on the assistant turn as reasoning_content; the nudge itself stays short.
    assert.equal(seen[1].at(-2).role, 'assistant');
    assert.equal(seen[1].at(-2).reasoning_content, 'THE PLAN: compare prerelease ids');
    assert.equal(seen[1].at(-1).content, 'Continue from your analysis above and make the next tool call now; keep reasoning brief.');
});

test('runLoop: runaway steps do not count, up to six per loop; then they do', async () => {
    let runaways = 0;
    const { ctx, seen } = fakeCtx([{ finish: 'length' }], { maxSteps: 2, onRunaway: () => runaways++ });
    const res = await runLoop(ctx);
    assert.equal(res.passed, false);
    assert.equal(seen.length, 8, 'six free runaways plus two counted steps');
    assert.equal(runaways, 8);
});

test('runLoop: in verify mode too, runaways are free; each cut-off doubles the next budget until a tool call', async () => {
    const scales = [];
    const { ctx } = fakeCtx([{ finish: 'think_budget' }, { finish: 'think_budget' }, { calls: [['run_node', { code: '1' }]] },
        { finish: 'think_budget' }, { calls: [['run_node', { code: '2' }]] }, { calls: [['done', { summary: 'ok' }]] }],
    { mode: 'verify', system: VERIFY_SYSTEM, maxSteps: 3, runCheck: async () => ({ ok: true, code: 0, output: 'ok' }) });
    const chat = ctx.chat;
    ctx.chat = (m, o) => { scales.push(o.budgetScale); return chat(m, o); };
    const res = await runLoop(ctx);
    assert.equal(res.finished, true);
    assert.equal(res.steps, 3, 'three cut-offs did not use steps');
    assert.deepEqual(scales, [1, 2, 4, 1, 2, 1]);
});

test('runLoop: verify steps think at a fixed 4096-token budget, not doubled after a cut-off; fix steps pass none', async () => {
    const seenOpts = [];
    const wrap = (ctx) => {
        const chat = ctx.chat;
        ctx.chat = (m, o) => { seenOpts.push(o); return chat(m, o); };
    };
    // verify mode: two thinking cut-offs in a row, then a probe and done.
    const v = fakeCtx([
        { finish: 'think_budget' }, { finish: 'think_budget' },
        { calls: [['run_node', { code: '1' }]] }, { calls: [['done', { summary: 'ok' }]] },
    ], { mode: 'verify', system: VERIFY_SYSTEM, maxSteps: 4, verifyThink: 4096,
        runCheck: async () => ({ ok: true, code: 0, output: 'ok' }) }).ctx;
    wrap(v);
    const res = await runLoop(v);
    assert.equal(res.finished, true);
    assert.equal(seenOpts.length, 4, 'two free cut-offs plus the probe and done');
    for (const o of seenOpts) {
        assert.equal(o.thinkBudget, 4096, 'every verify step gets the fixed thinking budget');
        assert.equal(o.budgetScale, 1, 'a cut-off does not double it');
    }
    // fix mode: the same cut-off still doubles the next step's budget, but no thinkBudget is passed.
    seenOpts.length = 0;
    const f = fakeCtx([
        { finish: 'think_budget' }, { calls: [['run_check']] }, { calls: [['done', { summary: 's' }]] },
    ], { runCheck: async () => ({ ok: true, code: 0, output: 'ok' }) }).ctx;
    wrap(f);
    const fres = await runLoop(f);
    assert.equal(fres.passed, true);
    assert.deepEqual(seenOpts.map((o) => o.budgetScale), [1, 2, 1], 'fix mode still doubles after a cut-off');
    for (const o of seenOpts) assert.equal(o.thinkBudget, undefined, 'no fixed budget in fix mode');
});

test('runLoop: a reply that stopped after thinking through most of its budget is a runaway, not done', async () => {
    const { ctx, seen } = fakeCtx([{ text: '', finish: 'stop', reasoning: 95, out: 96 }, { calls: [['done', { summary: 's' }]] }],
        { maxTokens: 100, runCheck: async () => ({ ok: true, code: 0, output: 'ok' }) });
    const res = await runLoop(ctx);
    assert.equal(res.passed, true);
    assert.equal(res.steps, 1, 'the runaway step was free');
    assert.equal(seen[1].at(-1).content, 'Continue from your analysis above and make the next tool call now; keep reasoning brief.');
});

test('runLoop: a step that streams reasoning sends it back in full as reasoning_content on the next request', async () => {
    const plan = `THE PLAN: `.repeat(50) + 'then edit.'; // 514 chars: nothing is tailed or cut on the way back
    const { ctx, seen } = fakeCtx([
        { reasoningText: plan, calls: [['run_node', { code: '1' }]] },
        { reasoningText: 'second thought', calls: [['run_node', { code: '2' }]] },
        { reasoningText: 'third thought', calls: [['done', { summary: 's' }]] },
    ], { runCheck: async () => ({ ok: true, code: 0, output: 'ok' }) });
    const res = await runLoop(ctx);
    assert.equal(res.passed, true);
    assert.equal(seen[1].at(-2).role, 'assistant');
    assert.equal(seen[1].at(-2).reasoning_content, plan, 'the next request carries the whole analysis');
    const turns = seen[2].filter((m) => m.role === 'assistant');
    assert.deepEqual(turns.map((m) => m.reasoning_content), [plan, 'second thought'], 'every turn keeps its own');
});

test('loop rules ask for brief thinking', () => {
    assert.match(FIX_SYSTEM, /Think briefly; prefer running code over long reasoning\./);
    assert.match(VERIFY_SYSTEM, /Think briefly; prefer running code over long reasoning\./);
});

test('a first reply that stops after spending most of max_tokens thinking: dropped in the race, free retry with loop: false', () => {
    const { one, check } = setup();
    const long = { content: 'I have analysed the problem.', finish: 'stop', out: 15100, reasoning: 15000 };
    // Default flow: the one-shot attempt is raced, and a runaway one-shot is dropped without a retry; the loop carries on.
    const { text, isError } = call({ prompt: 'x', files: [one], check, max_tokens: 16000 }, [long,
        tools(['edit', { path: 'one.txt', search: 'start', replace: 'good' }], ['done', { summary: 'fixed' }])]);
    assert.equal(isError, false, text);
    assert.match(text, /^check passed in the tool loop at step 1 of 30 \(attempt 1 missed\)/);
    assert.equal(requests().length, 2, 'the dropped attempt got no retry');

    // The retry flow (loop: false) still gives the runaway a free retry with the order to stop thinking.
    writeFileSync(one, 'start\nkeep\n');
    writeFileSync(join(dir, 'requests.jsonl'), '');
    const retried = call({ prompt: 'x', files: [one], check, max_tokens: 16000, loop: false }, [long, block(one, edit('start', 'good'))]);
    assert.match(retried.text, /^check passed on attempt 1 of 3/);
    const reqs = requests();
    assert.equal(reqs.length, 2);
    assert.match(reqs[1].messages.at(-1).content, /spent its output budget \(15100 tokens\) on thinking[\s\S]*Stop thinking now/);
});

test('a short reply without blocks is not a runaway: it counts as a missed attempt', () => {
    const { one, check } = setup();
    const { text } = call({ prompt: 'x', files: [one], check, max_tokens: 16000, loop: false, max_attempts: 2 }, [
        { content: 'no blocks', finish: 'stop', out: 3000, reasoning: 2900 },
        block(one, edit('start', 'good')),
    ]);
    assert.match(text, /^check passed on attempt 2 of 2/);
});

test('runLoop: in verify mode done is refused once until a run_node probe ran; the next done goes straight to the check', async () => {
    const { ctx, seen } = fakeCtx([
        { calls: [['done', { summary: 'all good' }]] },
        { calls: [['done', { summary: 'all good' }]] },
    ], { mode: 'verify', system: VERIFY_SYSTEM, runCheck: async () => ({ ok: true, code: 0, output: 'ok' }) });
    const res = await runLoop(ctx);
    assert.equal(res.passed, true);
    assert.equal(res.finished, true);
    assert.equal(res.steps, 2, 'the refused done used a step; the second was accepted');
    assert.equal(seen[1].at(-1).content, 'not yet: first test the spec rules with run_node.');
    assert.match(VERIFY_SYSTEM, /If your assert contradicts the spec, the assert is wrong/);
});

test('runLoop: on the second-to-last verify step a "One step left" nudge is sent', async () => {
    const { ctx, seen } = fakeCtx([
        { calls: [['run_node', { code: '1' }]] },
        { calls: [['done', { summary: 'ok' }]] },
    ], { mode: 'verify', system: VERIFY_SYSTEM, maxSteps: 2, runCheck: async () => ({ ok: true, code: 0, output: 'ok' }) });
    const res = await runLoop(ctx);
    assert.equal(res.finished, true);
    assert.equal(res.steps, 2);
    assert.equal(seen[1].at(-1).content, 'One step left. If your asserts pass and the check passes, call done now.');
});

test('runLoop: within 25 s of the verify time limit a "Time is nearly up" nudge is pushed once', async () => {
    // verifyMs just under the 25 s nudge threshold: less than 25 s remains from the first step on, whatever the
    // clock says, while the limit itself would need a full 24,999 ms to be reached, so no delay is needed.
    const { ctx, seen } = fakeCtx([
        { calls: [['run_node', { code: '1' }]] },
        { calls: [['done', { summary: 'ok' }]] },
    ], { mode: 'verify', system: VERIFY_SYSTEM, verifyMs: 24999,
        runCheck: async () => ({ ok: true, code: 0, output: 'ok' }) });
    const res = await runLoop(ctx);
    assert.equal(res.finished, true);
    assert.equal(res.steps, 2, 'the nudged step called done');
    const nudge = 'Time is nearly up. If your asserts pass and the check passes, call done now.';
    const pushed = seen.flatMap((s) => s).filter((m) => m.role === 'user' && m.content === nudge);
    assert.equal(pushed.length, 1, 'pushed exactly once, before the next step');
    assert.ok(!seen[1].some((m) => m.content.startsWith('One step left')), 'the step-count nudge was not sent instead');
});

test('runLoop: with selfCheck, an accepted done switches to the self-check in the same conversation', async () => {
    const f = join(dir, 'f.txt');
    writeFileSync(f, 'a\n');
    const { ctx, seen } = fakeCtx([
        { calls: [['edit', { path: 'f.txt', search: 'a', replace: 'b' }], ['run_check']] },
        { calls: [['done', { summary: 'fixed it' }]] },
        { calls: [['run_node', { code: '1' }]] },
        { calls: [['done', { summary: 'rules hold' }]] },
    ], { selfCheck: { steps: 4 }, files: [f], runCheck: async () => ({ ok: true, code: 0, output: 'ok' }) });
    const res = await runLoop(ctx);
    assert.equal(res.passed, true);
    assert.equal(res.finished, true);
    assert.equal(res.steps, 4);
    assert.equal(res.summary, 'fixed it', 'the fix summary is kept');
    assert.deepEqual(res.selfCheck, { finished: true, steps: 2, edits: 0, summary: 'rules hold' });
    // The self-check rides on the fix conversation: the same system prompt, the fix turns still in front.
    assert.equal(seen[2][0].content, FIX_SYSTEM, 'no new system message');
    assert.equal(seen[2].at(-1).role, 'user');
    assert.equal(seen[2].at(-1).content, SELF_CHECK_PROMPT);
    assert.ok(seen[2].some((m) => m.role === 'assistant' && m.tool_calls?.some((c) => c.function.name === 'edit')),
        'the fix turns lead the self-check');
});

test('runLoop: a self-check that runs out of steps keeps its edits while the check passes, undoes them when it fails', async () => {
    const f = join(dir, 'f.txt');
    const replies = [
        { calls: [['edit', { path: 'f.txt', search: 'a', replace: 'b' }], ['run_check']] },
        { calls: [['done', { summary: 'fixed it' }]] },
        { calls: [['edit', { path: 'f.txt', search: 'b', replace: 'c' }]] },
    ];
    const mk = (failAfter) => {
        let checks = 0;
        return fakeCtx(replies, { selfCheck: { steps: 1 }, files: [f],
            runCheck: async () => { checks++; const ok = checks <= failAfter; return { ok, code: ok ? 0 : 1, output: ok ? 'ok' : 'nope' }; } }).ctx;
    };

    writeFileSync(f, 'a\n');
    const kept = await runLoop(mk(10));
    assert.equal(kept.passed, true);
    assert.equal(kept.finished, true, 'the fix itself finished');
    assert.equal(kept.summary, 'fixed it');
    assert.deepEqual(kept.selfCheck, { finished: false, steps: 1, edits: 1, undone: false });
    assert.equal(kept.edits, 2);
    assert.equal(readFileSync(f, 'utf8'), 'c\n', 'the self-check edit is kept');

    // The done at step 2 reads the cached check result, so the re-run after the self-check edit is call number 2.
    writeFileSync(f, 'a\n');
    const undone = await runLoop(mk(1));
    assert.deepEqual(undone.selfCheck, { finished: false, steps: 1, edits: 1, undone: true });
    assert.equal(undone.edits, 1);
    assert.equal(readFileSync(f, 'utf8'), 'b\n', 'the self-check edit is undone, the fix kept');
});

test('runLoop: the self-check stops when its time limit is reached; its edits are kept while the check passes, undone when they break it', async () => {
    const f = join(dir, 'f.txt');
    // The fix takes two fast steps; every self-check step waits 50 ms, so the 30 ms deadline passes between its
    // first and second step (a timer fires no earlier than asked, so the timeout is guaranteed to be hit).
    const mk = (selfCheckReply, runCheck) => {
        const { ctx } = fakeCtx([
            { calls: [['edit', { path: 'f.txt', search: 'a', replace: 'b' }], ['run_check']] },
            { calls: [['done', { summary: 'fixed it' }]] },
            selfCheckReply,
        ], { selfCheck: { steps: 4 }, files: [f], verifyMs: 30, runCheck });
        const chat = ctx.chat;
        ctx.chat = async (m, o) => { await new Promise((r) => setTimeout(r, 50)); return chat(m, o); };
        return ctx;
    };

    // Probes only: the self-check times out without an edit, and the fix's result stands.
    writeFileSync(f, 'a\n');
    const logs = [];
    const ctx = mk({ calls: [['run_node', { code: '1' }]] },
        async () => ({ ok: true, code: 0, output: 'ok' }));
    ctx.log = (l) => logs.push(l);
    const timed = await runLoop(ctx);
    assert.equal(timed.passed, true);
    assert.equal(timed.finished, true, 'the fix itself finished');
    assert.equal(timed.summary, 'fixed it');
    assert.deepEqual(timed.selfCheck, { finished: false, steps: 1, edits: 0, undone: false, timedOut: true });
    assert.ok(logs.some((l) => l.includes('verify time limit reached')), logs.join('\n'));
    assert.ok(logs.some((l) => l.includes('self-check out of time')), logs.join('\n'));

    // The self-check edit breaks the check: the files go back to how they were when the fix finished.
    writeFileSync(f, 'a\n');
    const ctx2 = mk({ calls: [['edit', { path: 'f.txt', search: 'b', replace: 'c' }]] },
        async () => { const ok = readFileSync(f, 'utf8') === 'b\n'; return { ok, code: ok ? 0 : 1, output: ok ? 'ok' : 'not b' }; });
    const undone = await runLoop(ctx2);
    assert.equal(undone.passed, true);
    assert.equal(undone.finished, true);
    assert.deepEqual(undone.selfCheck, { finished: false, steps: 1, edits: 1, undone: true, timedOut: true });
    assert.equal(undone.edits, 1);
    assert.equal(readFileSync(f, 'utf8'), 'b\n', 'the self-check edit is undone, the fix kept');
});

test('runLoop: out of steps is never reported as finished, even when the check passes', async () => {
    const { ctx } = fakeCtx([{ calls: [['run_check']] }], { maxSteps: 2, runCheck: async () => ({ ok: true, code: 0, output: 'ok' }) });
    const res = await runLoop(ctx);
    assert.equal(res.passed, true);
    assert.equal(res.finished, false);
});

// --- The optional verify step: once the check passes, a short tool loop in mode 'verify' tests the spec rules the
// check does not cover with run_node asserts, fixes what breaks them, and calls done. When a one-shot won, it
// continues that attempt's conversation; when the loop lane won, it already ran as the lane's self-check.

test('verify: passes with no edits when the model\'s asserts hold', () => {
    const { one, check } = setup();
    const { text, isError, structured } = call({ prompt: 'make it good', files: [one], check, verify: true }, [
        block(one, edit('start', 'good')),
        tools(['run_node', { code: "import { readFileSync } from 'node:fs';\nconst t = readFileSync('./one.txt', 'utf8');\n" +
            "if (!t.includes('good')) process.exit(1);\nconsole.log('rules hold');" }]),
        tools(['done', { summary: 'the rules hold' }]),
    ]);
    assert.equal(isError, false, text);
    assert.match(text, /^check passed on parallel attempt 1 of 1/);
    assert.match(text, /verify: passed: the model's self-check found nothing to fix: the rules hold/);
    assert.doesNotMatch(text, /fallback/);
    assert.equal(readFileSync(one, 'utf8'), 'good\nkeep\n');
    assert.deepEqual(structured, { ok: true, verified: true, attempts: 1, steps: 2 });
    assert.equal(requests().length, 3, 'one attempt and two verify steps');
});

test('verify: a genuine failure is fixed with an edit, and the check still passes', () => {
    const { one, check } = setup();
    const { text, isError, structured } = call({ prompt: 'x', files: [one], check, verify: true }, [
        block(one, edit('start', 'good')),
        tools(['run_node', { code: "console.log('the spec wants kept, not keep')" }]),
        tools(['edit', { path: 'one.txt', search: 'keep', replace: 'kept' }], ['run_check']),
        tools(['done', { summary: 'fixed keep to kept' }]),
    ]);
    assert.equal(isError, false, text);
    assert.match(text, /verify: fixed: the self-check found a problem; 1 edit, and the check still passes: fixed keep to kept/);
    assert.equal(text.match(/one\.txt/g).length, 1, 'each file is listed once');
    assert.equal(readFileSync(one, 'utf8'), 'good\nkept\n');
    assert.deepEqual(structured, { ok: true, verified: true, attempts: 1, steps: 3 });
});

test('verify: a one-shot winner\'s self-check continues its conversation, with no new system message', () => {
    const { one, check } = setup();
    const { text, isError } = call({ prompt: 'make it good', files: [one], check, verify: true }, [
        block(one, edit('start', 'good')),
        tools(['run_node', { code: "console.log('rules hold')" }]),
        tools(['done', { summary: 'ok' }]),
    ]);
    assert.equal(isError, false, text);
    const verifyReq = requests().find((r) => r.tools);
    assert.ok(verifyReq, 'the verify loop asks with tools');
    const msgs = verifyReq.messages;
    assert.notEqual(msgs[0].content, VERIFY_SYSTEM, 'no new system message');
    assert.match(msgs[0].content, /Reply with only file blocks/, 'the attempt\'s own system prompt is kept');
    assert.match(msgs[1].content, /make it good/);
    assert.equal(msgs[2].role, 'assistant');
    assert.match(msgs[2].content, /=== FILE: .*one\.txt ===/, 'the winning attempt\'s reply leads the history');
    assert.equal(msgs[3].role, 'user');
    assert.match(msgs[3].content, /Your edits were applied and the check passes/);
    assert.ok(msgs[3].content.includes(VERIFY_SYSTEM), 'the verify instructions ride in the user turn');
});

test('verify: out of steps with the check passing keeps the edits; verified false, no fallback', () => {
    const { one, check } = setup();
    const { text, isError, structured } = call({ prompt: 'x', files: [one], check, verify: true, max_steps: 2 }, [
        block(one, edit('start', 'good')),
        tools(['edit', { path: 'one.txt', search: 'keep', replace: 'kept' }]),
        tools(['run_check']),
    ]);
    assert.equal(isError, false, text);
    assert.match(text, /verify: incomplete: the self-check ran out of steps; kept its 1 edit, since the check still passes/);
    assert.doesNotMatch(text, /fallback/);
    assert.equal(readFileSync(one, 'utf8'), 'good\nkept\n');
    assert.deepEqual(structured, { ok: true, verified: false, attempts: 1, steps: 2 });
});

test('verify: out of steps with the check failing undoes the edits; the files are as they were when the check passed', () => {
    const { one, check } = setup();
    const { text, isError, structured } = call({ prompt: 'x', files: [one], check, verify: true, max_steps: 2 }, [
        block(one, edit('start', 'good')),
        tools(['edit', { path: 'one.txt', search: 'good', replace: 'bad' }]),
        tools(['run_check']),
    ]);
    assert.equal(isError, false, text);
    assert.match(text, /verify: incomplete: the self-check ran out of steps with the check failing; its changes were undone, so the files are as they were when the check passed/);
    assert.equal(readFileSync(one, 'utf8'), 'good\nkeep\n');
    assert.deepEqual(structured, { ok: true, verified: false, attempts: 1, steps: 2 });
});

test('verify: with a tiny WARRIORGPT_VERIFY_MS the self-check runs out of time: verified false, no fallback', () => {
    const { one, check } = setup();
    // The 1 ms limit passes before or during the first verify step; either way the note says it ran out of time.
    const { text, isError, structured } = call({ prompt: 'x', files: [one], check, verify: true }, [
        block(one, edit('start', 'good')),
        tools(['run_node', { code: "console.log('rules hold')" }]),
        tools(['done', { summary: 'ok' }]),
    ], { WARRIORGPT_VERIFY_MS: '1' });
    assert.equal(isError, false, text);
    assert.match(text, /verify: incomplete: the self-check ran out of time/);
    assert.doesNotMatch(text, /fallback/);
    assert.equal(structured.ok, true);
    assert.equal(structured.verified, false);
    assert.equal(structured.fallback, undefined);
    assert.equal(readFileSync(one, 'utf8'), 'good\nkeep\n', 'the passing fix is kept');
});

test('verify: CLI exits 0 when the self-check is incomplete, with verified false and no fallback in its JSON line', () => {
    const { one, check } = setup();
    const res = spawnSync(process.execPath, ['--import', MOCK, CLI, '--prompt', 'x', '--files', one, '--check', check,
        '--parallel', '1', '--no-loop-lane', '--verify', '--max-steps', '2'], { encoding: 'utf8', env: env([
        block(one, edit('start', 'good')),
        tools(['edit', { path: 'one.txt', search: 'keep', replace: 'kept' }]),
        tools(['run_check']),
    ]) });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const json = JSON.parse(res.stdout.trim().split('\n').at(-1));
    assert.equal(json.ok, true);
    assert.equal(json.verified, false);
    assert.equal(json.fallback, undefined);
    assert.equal(json.steps, 2);
});

test('verify: off by default, and ignored without a check', () => {
    const { one, check } = setup();
    call({ prompt: 'x', files: [one], check }, [block(one, edit('start', 'good'))]);
    assert.equal(requests().length, 1);
});

test('loop: run_node and the check never see the API key', () => {
    const { one, check } = setup();
    call({ prompt: 'x', files: [one], check }, [
        block(one, edit('start', 'bad')),
        tools(['run_node', { code: "console.log('key=' + (process.env.WARRIORGPT_API_KEY ?? 'unset'))" }]),
        tools(['edit', { path: 'one.txt', search: 'bad', replace: 'good' }], ['done', { summary: 'ok' }]),
    ]);
    const result = requests()[2].messages.at(-1).content;
    assert.match(result, /key=unset/);
    assert.ok(!result.includes('test-key'));
});

test('runLoop: read-only calls in a row run at once; edits and checks keep their order; results stay in call order', async () => {
    const order = [];
    let live = 0;
    let peak = 0;
    const runNode = async (code) => {
        live++; peak = Math.max(peak, live); order.push(`start ${code}`);
        await new Promise((r) => setTimeout(r, 50));
        live--; order.push(`end ${code}`);
        return { ok: true, code: 0, output: `out ${code}` };
    };
    const runCheck = async () => { order.push('check'); return { ok: false, code: 1, output: 'nope' }; };
    const { ctx, seen } = fakeCtx([{ calls: [['run_node', { code: 'a' }], ['run_node', { code: 'b' }], ['run_node', { code: 'c' }],
        ['run_check'], ['run_node', { code: 'd' }]] }], { maxSteps: 2, runNode, runCheck });
    const logs = [];
    ctx.log = (l) => logs.push(l);
    await runLoop(ctx);
    assert.equal(peak, 3);
    assert.ok(order.indexOf('check') > order.indexOf('end c'), order.join(', '));
    assert.ok(order.indexOf('start d') > order.indexOf('check'), order.join(', '));
    const tool = seen[1].filter((m) => m.role === 'tool').map((m) => m.content.split(String.fromCharCode(10)).at(-1));
    assert.deepEqual(tool, ['out a', 'out b', 'out c', 'nope', 'out d']);
    assert.ok(logs.some((l) => l === '--- 3 read-only calls ran at once'));
});

test('verify: when the check never passes, no verify request goes out at all', () => {
    const { one, check } = setup();
    const { isError } = call({ prompt: 'x', files: [one], check, verify: true, max_steps: 1 },
        [block(one, edit('start', 'bad')), tools(['run_check'])]);
    assert.equal(isError, true);
    assert.equal(requests().length, 2, 'the attempt and one loop step; nothing after the failed check');
});
