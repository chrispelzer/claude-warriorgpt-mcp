// v3.1 speed work: thinking budget (stream cut-off), output caps, the thinking switch.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const SERVER = resolve(here, '../warriorgpt-mcp.mjs');
const MOCK = pathToFileURL(join(here, 'mock-fetch.mjs')).href;

let dir;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'warriorgpt-speed-test-'));
});

function call(args, replies, extra = {}) {
    writeFileSync(join(dir, 'replies.json'), JSON.stringify(replies));
    const home = join(dir, 'home');
    mkdirSync(home, { recursive: true });
    const res = spawnSync(process.execPath, ['--import', MOCK, SERVER], {
        input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ask_warriorgpt', arguments: { parallel: 1, loop_lane: false, ...args } } }) + '\n',
        encoding: 'utf8',
        env: { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: home, WARRIORGPT_API_KEY: 'test-key',
            CLAUDE_CODE_SESSION_ID: 'test', MOCK_REPLIES: join(dir, 'replies.json'), MOCK_REQUEST: join(dir, 'request.json'),
            MOCK_REQUEST_LOG: join(dir, 'requests.jsonl'), MOCK_STREAM: '1', ...extra },
    });
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout.trim().split('\n')[0]);
    return { text: out.result.content[0].text, isError: !!out.result.isError, structured: out.result.structuredContent };
}

const requests = () => readFileSync(join(dir, 'requests.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const block = (path, body) => `=== FILE: ${path} ===\n${body}\n=== END FILE ===`;
const edit = (search, replace) => `<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE`;
const tools = (...calls) => ({ tool_calls: calls.map(([name, args = {}]) => ({ name, arguments: args })) });
const kw = (r) => r.chat_template_kwargs?.enable_thinking;

function setup() {
    const one = join(dir, 'one.txt');
    writeFileSync(one, 'start\nkeep\n');
    writeFileSync(join(dir, 'check.mjs'), "import { readFileSync } from 'node:fs';\n" +
        "const t = readFileSync(new URL('./one.txt', import.meta.url), 'utf8');\n" +
        "if (!t.includes('good')) { console.log('one.txt is NOT GOOD: ' + t.trim()); process.exit(1); }\n");
    return { one, check: `"${process.execPath}" check.mjs` };
}

// 20,000 characters of reasoning is about 5,000 tokens: past the default 4,096 budget.
const LONG = 'Let me think about this carefully. '.repeat(572);

test('budget: a first reply still thinking past the budget is cut off and reissued with its analysis', () => {
    const { one, check } = setup();
    const log = join(dir, 'run.log');
    const { text, isError } = call({ prompt: 'x', files: [one], check, log_file: log }, [
        { reasoning_text: `${LONG}THE KEY INSIGHT`, content: block(one, edit('start', 'bad')) },
        block(one, edit('start', 'good')),
    ]);
    assert.equal(isError, false, text);
    assert.match(text, /^check passed on parallel attempt 1 of 1/);
    assert.equal(readFileSync(one, 'utf8'), 'good\nkeep\n', 'the cut-off reply wrote nothing');
    const reqs = requests();
    assert.equal(reqs.length, 2);
    const reissue = reqs[1].messages.at(-1).content;
    assert.match(reissue, /^Your analysis so far \(cut off at the thinking budget\):/);
    assert.match(reissue, /THE KEY INSIGHT\n>>>\n\nStop analysing\. Output the file blocks with your edits now\.$/);
    assert.equal(kw(reqs[0]), undefined, 'the first reply may think');
    assert.equal(kw(reqs[1]), false, 'the reissue asks the server to skip thinking');
    assert.match(readFileSync(log, 'utf8'), /thinking passed the 4096-token budget with nothing written; reissued to write its edits now, budget raised to 8192 tokens \(free retry 1 of 2\)/);
    assert.match(readFileSync(log, 'utf8'), /timing: headers \d+ ms, first reasoning \d+ ms, end \d+ ms/);
});

test('budget: replies that keep running over get two doubled budgets in the race, then the loop takes over', () => {
    // The race reissues a budget cut-off with its analysis and twice the budget (8k, then 16k), then drops the
    // attempt as out of thinking budget, and the tool loop starts from the untouched files. Its first step gets a
    // thinking budget seeded from what the attempt spent thinking, at most 16k.
    const { one, check } = setup();
    const log = join(dir, 'run.log');
    const { text, isError } = call({ prompt: 'x', files: [one], check, log_file: log }, [
        { reasoning_text: LONG, content: 'never seen' },
        { reasoning_text: `${LONG}${LONG}`, content: 'never seen' },
        { reasoning_text: `${LONG}${LONG}${LONG}${LONG}`, content: 'never seen' },
        tools(['edit', { path: 'one.txt', search: 'start', replace: 'good' }], ['run_check']),
        tools(['done', { summary: 'ok' }]),
    ]);
    assert.equal(isError, false, text);
    assert.match(text, /^check passed in the tool loop at step 2 of \d+/);
    assert.doesNotMatch(text, /warning:/, 'a pass is not blamed on the budget');
    assert.equal(readFileSync(one, 'utf8'), 'good\nkeep\n');
    const reqs = requests();
    assert.equal(reqs.length, 5);
    assert.deepEqual(reqs.slice(0, 3).map((r) => r.max_tokens), [16384, 16384, 24576]);
    assert.match(reqs[2].messages.at(-1).content, /^Your analysis so far/);
    const out = readFileSync(log, 'utf8');
    assert.match(out, /thinking passed the 4096-token budget with nothing written; reissued to write its edits now, budget raised to 8192 tokens \(free retry 1 of 2\)/);
    assert.match(out, /thinking passed the 16384-token budget with nothing written again; dropped: out of thinking budget/);
    assert.match(out, /the loop's first step gets a 16384-token thinking budget/);
});

test('budget: without the race, a cut-off is retried with twice the budget, and running out is reported as such', () => {
    const { one, check } = setup();
    const log = join(dir, 'run.log');
    const { text, isError } = call({ prompt: 'x', files: [one], check, loop: false, max_attempts: 1, log_file: log }, [
        { reasoning_text: LONG, content: 'never seen' },
        { reasoning_text: `${LONG}${LONG}`, content: 'never seen' },
        { content: '', finish: 'length', reasoning: 16384, out: 16384 },
    ]);
    assert.equal(isError, true);
    const reqs = requests();
    assert.equal(reqs.length, 3);
    const out = readFileSync(log, 'utf8');
    assert.match(out, /thinking passed the 4096-token budget with nothing written; cut off, free retry 1 of 2, budget raised to 8192 tokens/);
    assert.match(out, /thinking passed the 8192-token budget with nothing written; cut off, free retry 2 of 2, with no budget/);
    assert.match(text, /Last reply spent all of max_tokens thinking after 2 larger-budget retries/);
    assert.match(text, /warning: attempt 1 ran out of thinking budget before writing any file/);
    assert.match(out, /!!! WARNING: attempt 1 ran out of thinking budget/);
});

test('budget: think_budget 0 turns it off, and plain questions have none', () => {
    const { one, check } = setup();
    const r = call({ prompt: 'x', files: [one], check, think_budget: 0 },
        [{ reasoning_text: LONG, content: block(one, edit('start', 'good')) }]);
    assert.equal(r.isError, false, r.text);
    assert.equal(requests().length, 1);
    writeFileSync(join(dir, 'requests.jsonl'), '');
    const q = call({ prompt: 'why?' }, [{ reasoning_text: LONG, content: 'because' }]);
    assert.match(q.text, /^because/);
    assert.equal(requests().length, 1);
});

test('budget: a loop step past its budget is nudged with its analysis and does not use a step', () => {
    const { one, check } = setup();
    const { text, isError } = call({ prompt: 'x', files: [one], check, max_steps: 1 }, [
        block(one, edit('start', 'bad')),
        { reasoning_text: `${'hmm '.repeat(2000)}LOOP INSIGHT`, content: '' },
        tools(['edit', { path: 'one.txt', search: 'bad', replace: 'good' }], ['done', { summary: 'ok' }]),
    ]);
    assert.equal(isError, false, text);
    assert.match(text, /tool loop at step 1 of 1/);
    const reqs = requests();
    assert.equal(reqs.length, 3);
    // The analysis goes back on the assistant turn as reasoning_content; the nudge itself is short and fixed.
    const nudge = reqs[2].messages.at(-1);
    assert.equal(nudge.role, 'user');
    assert.equal(nudge.content, 'Continue from your analysis above and make the next tool call now; keep reasoning brief.');
    const turn = reqs[2].messages.at(-2);
    assert.equal(turn.role, 'assistant');
    assert.equal(turn.content, '');
    assert.match(turn.reasoning_content, /LOOP INSIGHT$/);
    assert.equal(kw(reqs[1]), undefined, 'auto: the first loop step may think');
    assert.equal(kw(reqs[2]), false, 'auto: after a runaway the switch is sent');
});

test('caps: 16,384 for the first reply and 8,192 per loop step by default; both configurable', () => {
    const { one, check } = setup();
    const replies = [block(one, edit('start', 'bad')), tools(['edit', { path: 'one.txt', search: 'bad', replace: 'good' }], ['done', { summary: 'ok' }])];
    call({ prompt: 'x', files: [one], check }, replies);
    assert.deepEqual(requests().map((r) => r.max_tokens), [16384, 8192]);
    assert.deepEqual(requests().map((r) => r.parallel_tool_calls), [undefined, true], 'loop steps allow parallel tool calls');
    writeFileSync(one, 'start\nkeep\n');
    writeFileSync(join(dir, 'requests.jsonl'), '');
    call({ prompt: 'x', files: [one], check, max_tokens: 10000, loop_max_tokens: 3000 }, replies);
    assert.deepEqual(requests().map((r) => r.max_tokens), [10000, 3000]);
});

test('loop_thinking: off sends the switch on every loop step, on never does', () => {
    const { one, check } = setup();
    const replies = [block(one, edit('start', 'bad')), { finish: 'length', content: '' },
        tools(['edit', { path: 'one.txt', search: 'bad', replace: 'good' }], ['done', { summary: 'ok' }])];
    call({ prompt: 'x', files: [one], check, loop_thinking: 'off' }, replies);
    assert.deepEqual(requests().map(kw), [undefined, false, false]);
    writeFileSync(one, 'start\nkeep\n');
    writeFileSync(join(dir, 'requests.jsonl'), '');
    call({ prompt: 'x', files: [one], check, loop_thinking: 'on' }, replies);
    assert.deepEqual(requests().map(kw), [undefined, undefined, undefined]);
    const bad = call({ prompt: 'x', files: [one], check, loop_thinking: 'sometimes' }, replies);
    assert.match(bad.text, /loop_thinking must be auto, on or off/);
});

test('a server that rejects the thinking switch is detected once; the request is resent without it', () => {
    const { one, check } = setup();
    const { text, isError } = call({ prompt: 'x', files: [one], check, loop_thinking: 'off' }, [
        block(one, edit('start', 'bad')),
        tools(['run_check']),
        tools(['edit', { path: 'one.txt', search: 'bad', replace: 'good' }], ['done', { summary: 'ok' }]),
    ], { MOCK_REJECT_KWARGS: '1' });
    assert.equal(isError, false, text);
    // attempt 1; loop step 1 with the switch (400), resent without; loop step 2 without.
    assert.deepEqual(requests().map(kw), [undefined, false, undefined, undefined]);
});
