// The one-shot attempts race the always-on tool-loop lane, each in its own copy of the tree; the first to pass wins.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, delimiter } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FIX_SYSTEM, SELF_CHECK_PROMPT } from '../loop.mjs';
import { failCount } from '../ask.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const SERVER = resolve(here, '../warriorgpt-mcp.mjs');
const MOCK = pathToFileURL(join(here, 'mock-fetch.mjs')).href;

let dir;
let tmp;
beforeEach(() => {
    // The project and the temp folder its copies go to sit side by side.
    const root = mkdtempSync(join(tmpdir(), 'warriorgpt-race-test-'));
    dir = join(root, 'proj');
    tmp = join(root, 'tmp');
    mkdirSync(dir);
    mkdirSync(tmp);
});

function call(args, replies, extra = {}) {
    writeFileSync(join(dir, 'replies.json'), JSON.stringify(replies));
    const home = join(dir, 'home');
    mkdirSync(home, { recursive: true });
    const res = spawnSync(process.execPath, ['--import', MOCK, SERVER], {
        input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ask_warriorgpt', arguments: args } }) + '\n',
        encoding: 'utf8',
        // Copies of the tree go to this test's own temp folder, so the test can see them cleaned up.
        env: { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: home, TEMP: tmp, TMP: tmp, TMPDIR: tmp,
            WARRIORGPT_API_KEY: 'test-key', CLAUDE_CODE_SESSION_ID: 'test', MOCK_REPLIES: join(dir, 'replies.json'),
            MOCK_REQUEST: join(dir, 'request.json'), MOCK_REQUEST_LOG: join(dir, 'requests.jsonl'), MOCK_STREAM: '1', ...extra },
    });
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout.trim().split('\n')[0]);
    return { text: out.result.content[0].text, isError: !!out.result.isError, structured: out.result.structuredContent };
}

const requests = () => readFileSync(join(dir, 'requests.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const block = (path, body) => `=== FILE: ${path} ===\n${body}\n=== END FILE ===`;
const edit = (search, replace) => `<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE`;
const tools = (...calls) => ({ tool_calls: calls.map(([name, args = {}]) => ({ name, arguments: args })) });

// one.txt must contain alpha, beta and gamma; the check prints how many are missing as node:test would.
function setup() {
    const one = join(dir, 'one.txt');
    writeFileSync(one, 'start\n');
    writeFileSync(join(dir, 'check.mjs'), "import { readFileSync } from 'node:fs';\n" +
        "const t = readFileSync(new URL('./one.txt', import.meta.url), 'utf8');\n" +
        "const missing = ['alpha', 'beta', 'gamma'].filter((w) => !t.includes(w));\n" +
        "console.log('ℹ fail ' + missing.length + (missing.length ? ' missing: ' + missing.join(' ') : ''));\n" +
        'process.exit(missing.length ? 1 : 0);\n');
    return { one, check: `"${process.execPath}" check.mjs`, log: join(dir, 'run.log') };
}
const ALL = 'alpha beta gamma';

test('race: one one-shot attempt by default; when it passes, it wins and the loop lane is cancelled', () => {
    const { one, check, log } = setup();
    // Both lanes now ask for a 16384-token output cap; only the lane carries tools, so its route must come first.
    writeFileSync(join(dir, 'routes.json'), JSON.stringify({
        '"tools"': [tools(['read_file', { path: 'one.txt' }])],
        '"max_tokens":16384': [block(one, edit('start', ALL))],
    }));
    const { text, isError } = call({ prompt: 'x', files: [one], check, log_file: log }, [], { MOCK_ROUTES: join(dir, 'routes.json') });
    assert.equal(isError, false, text);
    assert.match(text, /^check passed on parallel attempt 1 of 1 \(temperature 0\.6\)/);
    assert.equal(readFileSync(one, 'utf8'), `${ALL}\n`);
    const l = readFileSync(log, 'utf8');
    assert.match(l, /=== 1 parallel first attempt \(temperatures 0\.6; thinking budgets 4096; output caps 16384\)/);
    assert.match(l, /=== the loop lane races them from the start, in its own copy \(up to 30 steps; no thinking budget, 16384-token output cap\)/);
    assert.match(l, /--- \[a1\] check passed in \d+ ms \(in a copy of the tree\)/);
    assert.match(l, /--- \[loop\] cancelled: a one-shot attempt passed/);
    assert.match(l, /--- \[a1\] applied to the real files; check passed/);
    assert.deepEqual(readdirSync(tmp), [], 'every copy was removed');
});

test('race: the loop lane wins; the slower one-shot attempt is cancelled', () => {
    const { one, check, log } = setup();
    writeFileSync(join(dir, 'routes.json'), JSON.stringify({
        '"tools"': [tools(['edit', { path: 'one.txt', search: 'start', replace: ALL }]),
            tools(['done', { summary: 'all three words' }])],
        // The one-shot is slow and wrong anyway: the lane must not wait for it.
        '"max_tokens":16384': [{ content: block(one, edit('start', 'alpha')), delay_ms: 15000 }],
    }));
    const started = Date.now();
    const { text, isError } = call({ prompt: 'x', files: [one], check, log_file: log }, [], { MOCK_ROUTES: join(dir, 'routes.json') });
    assert.equal(isError, false, text);
    assert.match(text, /^check passed in the tool loop at step 2 of 30, racing 1 one-shot attempt from the start/);
    assert.ok(Date.now() - started < 10000, 'the slow attempt was not waited for');
    assert.equal(readFileSync(one, 'utf8'), `${ALL}\n`);
    const l = readFileSync(log, 'utf8');
    assert.match(l, /\[loop\] --- loop lane passed at step 2 \(in a copy of the tree\)/);
    assert.match(l, /--- \[loop\] applied to the real files; check passed/);
    assert.match(l, /--- \[a1\] cancelled: another attempt passed/);
    assert.equal(requests().length, 3, 'one try for the one-shot, two steps for the lane');
    assert.deepEqual(readdirSync(tmp), [], 'every copy was removed');
});

test('race: when neither lane passes, the real files are restored and it gives up', () => {
    const { one, check } = setup();
    writeFileSync(join(dir, 'routes.json'), JSON.stringify({
        '"tools"': [tools(['read_file', { path: 'one.txt' }])],
        '"max_tokens":16384': [block(one, edit('start', 'alpha'))],
    }));
    const { text, isError, structured } = call({ prompt: 'x', files: [one], check, max_steps: 2 }, [], { MOCK_ROUTES: join(dir, 'routes.json') });
    assert.equal(isError, true);
    assert.match(text, /^check did not pass in 1 attempt and 2 tool-loop steps/);
    assert.match(text, /Last check FAILED \(exit 1\)/);
    assert.deepEqual(structured, { ok: false, fallback: 'opencode', attempts: 1, steps: 2 });
    assert.equal(readFileSync(one, 'utf8'), 'start\n');
    assert.deepEqual(readdirSync(tmp), []);
});

test('race: a check that names the real folder is pointed at each copy', () => {
    const { one } = setup();
    const check = `"${process.execPath}" "${join(dir, 'check.mjs')}"`;
    writeFileSync(join(dir, 'routes.json'), JSON.stringify({
        '"tools"': [tools(['read_file', { path: 'one.txt' }])],
        '"max_tokens":16384': [block(one, edit('start', ALL))],
    }));
    const { text, isError } = call({ prompt: 'x', files: [one], check }, [], { MOCK_ROUTES: join(dir, 'routes.json') });
    assert.equal(isError, false, text);
    assert.match(text, /parallel attempt 1 of 1/);
});

test('verify: when the lane wins, the self-check runs in its conversation and the result is verified', () => {
    const { one, check, log } = setup();
    // Fix in two steps, then the self-check: probe with run_node, done. The one-shot stays slow and wrong.
    writeFileSync(join(dir, 'routes.json'), JSON.stringify({
        '"tools"': [tools(['edit', { path: 'one.txt', search: 'start', replace: ALL }], ['run_check']),
            tools(['done', { summary: 'all three words' }]),
            tools(['run_node', { code: "console.log('the spec rules hold')" }]),
            tools(['done', { summary: 'the rules hold' }])],
        '"max_tokens":16384': [{ content: block(one, edit('start', 'alpha')), delay_ms: 15000 }],
    }));
    const started = Date.now();
    const { text, isError, structured } = call({ prompt: 'x', files: [one], check, verify: true, log_file: log }, [], { MOCK_ROUTES: join(dir, 'routes.json') });
    assert.equal(isError, false, text);
    assert.ok(Date.now() - started < 10000, 'the slow attempt was not waited for');
    assert.match(text, /^check passed in the tool loop at step 2 of 30, racing 1 one-shot attempt from the start/);
    assert.match(text, /verify: passed: the model's self-check found nothing to fix: the rules hold/);
    assert.equal(readFileSync(one, 'utf8'), `${ALL}\n`);
    assert.deepEqual(structured, { ok: true, verified: true, attempts: 1, steps: 4 });
    const l = readFileSync(log, 'utf8');
    assert.match(l, /\[loop\] --- fix finished at step 2; self-check in the same conversation \(up to 8 steps\)/);
    assert.match(l, /=== verify: passed: the model's self-check found nothing to fix: the rules hold \(in the loop lane's conversation, 2 steps\)/);
    const sc = requests().find((r) => r.messages.some((m) => typeof m.content === 'string' && m.content.includes(SELF_CHECK_PROMPT)));
    assert.ok(sc, 'a request carries the self-check prompt');
    assert.ok(sc.messages[0].content.startsWith(FIX_SYSTEM), 'the lane keeps its own system prompt');
    assert.ok(sc.messages.some((m) => m.role === 'assistant' && m.tool_calls?.some((c) => c.function.name === 'edit')),
        'the fix turns lead the self-check');
    assert.deepEqual(readdirSync(tmp), [], 'every copy was removed');
});

test('files outside the working directory fall back to one attempt; loop: false never races', () => {
    const { one, check } = setup();
    const sub = join(dir, 'sub');
    mkdirSync(sub);
    writeFileSync(join(sub, 'check.mjs'), readFileSync(join(dir, 'check.mjs'), 'utf8').replace("'./one.txt'", "'../one.txt'"));
    const r = call({ prompt: 'x', files: [one], check, cwd: sub }, [block(one, edit('start', ALL))]);
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /^check passed on attempt 1 of 1/);
    assert.equal(requests().length, 1);
    writeFileSync(one, 'start\n');
    writeFileSync(join(dir, 'requests.jsonl'), '');
    const s = call({ prompt: 'x', files: [one], check, loop: false }, [block(one, edit('start', ALL))]);
    assert.match(s.text, /^check passed on attempt 1 of 3/);
    assert.equal(requests().length, 1);
});

test('failCount reads node:test and mocha summaries', () => {
    assert.equal(failCount('# tests 5\n# pass 3\n# fail 2\n'), 2);
    assert.equal(failCount('ℹ tests 9\nℹ fail 4\n'), 4);
    assert.equal(failCount('  3 passing\n  1 failing\n'), 1);
    assert.equal(failCount('Error: boom'), 1e6);
});

test('splitCommand: plain node checks are spawned directly; anything shell-like goes to the shell', async () => {
    const { splitCommand } = await import('../ask.mjs');
    const exe = '/usr/bin/node';
    assert.deepEqual(splitCommand('node --test "test/*.test.mjs"', 'linux', exe), [exe, '--test', 'test/*.test.mjs']);
    assert.deepEqual(splitCommand('  node   check.mjs  ', 'linux', exe), [exe, 'check.mjs']);
    assert.deepEqual(splitCommand('node --test=a"b c"d', 'linux', exe), [exe, '--test=ab cd']);
    assert.deepEqual(splitCommand(`${exe} x.mjs`, 'linux', exe), [exe, 'x.mjs']);
    const win = String.raw`C:\Program Files\nodejs\node.exe`;
    assert.deepEqual(splitCommand(`"${win}" check.mjs`, 'win32', win), [win, 'check.mjs']);
    assert.deepEqual(splitCommand(String.raw`NODE.EXE "C:\a b\t.mjs"`, 'win32', win), [win, String.raw`C:\a b\t.mjs`]);
    for (const c of ['npm test', 'node a.mjs | tee x', 'node a.mjs && node b.mjs', 'node a.mjs > out', 'node $X', 'node %X%',
        'node test/*.mjs', "node 'a b.mjs'", 'FOO=1 node a.mjs', 'node "unpaired', String.raw`node a\b.mjs`, 'node ~/a.mjs', '', 'node `x`',
        'node a.mjs; rm -rf x', 'node a.mjs\nnode b.mjs', 'nodejs a.mjs', '/other/node a.mjs']) {
        assert.equal(splitCommand(c, 'linux', exe), null, c);
    }
    assert.equal(splitCommand('node a.mjs ^& calc', 'win32', win), null);
});

test('a check that needs a shell still runs in one', () => {
    const { one } = setup();
    writeFileSync(join(dir, 'second.mjs'), "console.log('SECOND RAN');\n");
    const check = `"${process.execPath}" check.mjs && "${process.execPath}" second.mjs`;
    const log = join(dir, 'run.log');
    writeFileSync(join(dir, 'routes.json'), JSON.stringify({
        '"tools"': [tools(['read_file', { path: 'one.txt' }])],
        '"max_tokens":16384': [block(one, edit('start', ALL))],
    }));
    const { text, isError } = call({ prompt: 'x', files: [one], check, log_file: log }, [], { MOCK_ROUTES: join(dir, 'routes.json') });
    assert.equal(isError, false, text);
    assert.match(text, /parallel attempt 1 of 1/);
    assert.match(readFileSync(log, 'utf8'), /SECOND RAN/);
});

test('race: a portfolio of thinking budgets races the loop lane; when nothing passes, it gives up', () => {
    const { one, check, log } = setup();
    // Each attempt is told apart by its output cap: 16384 (4k budget), 28672 (12k budget), 32768 (20k budget); the
    // loop lane is the only request that carries tools.
    const long = { reasoning_text: 'Let me think about this carefully. '.repeat(600), content: 'never seen' }; // ~5k tokens
    // a1's reissues double its budget: 8k (same cap), then 16k (cap 24576); each thinks past it.
    const longer = { reasoning_text: long.reasoning_text.repeat(2), content: 'never seen' }; // ~10k tokens
    const longest = { reasoning_text: long.reasoning_text.repeat(4), content: 'never seen' }; // ~21k tokens
    writeFileSync(join(dir, 'routes.json'), JSON.stringify({
        '"tools"': [tools(['read_file', { path: 'one.txt' }])],
        '"max_tokens":16384': [long, longer],
        '"max_tokens":24576': [longest],
        '"max_tokens":28672': [{ reasoning_text: long.reasoning_text, content: block(one, edit('start', 'alpha beta')) }],
        '"max_tokens":32768': [{ content: block(one, edit('start', 'alpha')), reasoning: 10000, out: 10500 }],
    }));
    const { text, isError, structured } = call({ prompt: 'x', files: [one], check, parallel: 3, max_steps: 2, log_file: log },
        [], { MOCK_ROUTES: join(dir, 'routes.json') });
    assert.equal(isError, true);
    assert.match(text, /^check did not pass in 3 attempts and 2 tool-loop steps/);
    assert.deepEqual(structured, { ok: false, fallback: 'opencode', attempts: 3, steps: 2 });
    const l = readFileSync(log, 'utf8');
    assert.match(l, /=== 3 parallel first attempts \(temperatures 0\.6, 0\.3, 0\.8; thinking budgets 4096, 12288, 20480; output caps 16384, 28672, 32768\)/);
    assert.match(l, /\[a1\] thinking passed the 4096-token budget with nothing written; reissued to write its edits now, budget raised to 8192 tokens \(free retry 1 of 2\)/);
    assert.match(l, /\[a1\] thinking passed the 8192-token budget with nothing written; reissued to write its edits now, budget raised to 16384 tokens \(free retry 2 of 2\)/);
    assert.match(l, /\[a1\] thinking passed the 16384-token budget with nothing written again; dropped: out of thinking budget/);
    assert.match(text, /warning: attempt 1 ran out of thinking budget before writing any file, with the budget doubled on each retry up to 16384 tokens: that is the budget, not a wrong answer/);
    assert.doesNotMatch(l, /\[a2\] thinking passed/, 'the 12k attempt was not cut off at ~5k tokens');
    assert.match(l, /no parallel attempt passed and the loop lane is out of steps; \[a2\] was closest \(1 failing\)/);
    assert.match(l, /=== no lane passed: neither the one-shot attempts nor the loop lane/);
    assert.equal(requests().length, 7, 'three tries for a1, one each for a2 and a3, two steps for the lane');
    const a1 = requests().filter((r) => !r.tools && r.max_tokens !== 28672 && r.max_tokens !== 32768);
    assert.deepEqual(a1.map((r) => r.max_tokens), [16384, 16384, 24576], 'a 16k budget gets room to write');
    assert.equal(a1[2].messages.filter((m) => m.role === 'user').length, 2, 'one budget prompt, not one per reissue');
    assert.equal(readFileSync(one, 'utf8'), 'start\n');
    assert.deepEqual(readdirSync(tmp), []);
});

test('race: a runaway attempt is dropped, with no runaway retries inside the race', () => {
    const { one, check, log } = setup();
    writeFileSync(join(dir, 'routes.json'), JSON.stringify({
        '"tools"': [tools(['read_file', { path: 'one.txt' }])],
        '"max_tokens":16384': [{ content: '', finish: 'length', reasoning: 16384, out: 16384 }],
        '"max_tokens":28672': [{ content: 'I have thought about it.', reasoning: 28000, out: 28010 }],
        '"max_tokens":32768': [block(one, edit('start', ALL))],
    }));
    const { text, isError } = call({ prompt: 'x', files: [one], check, parallel: 3, log_file: log }, [], { MOCK_ROUTES: join(dir, 'routes.json') });
    assert.equal(isError, false, text);
    assert.match(text, /parallel attempt 3 of 3/);
    const l = readFileSync(log, 'utf8');
    assert.match(l, /\[a1\] runaway thinking \(16384 tokens, nothing usable\); dropped/);
    // A normal stop with nothing usable after a long think counts as a runaway too (v3 bench, a-duration #1).
    assert.match(l, /\[a2\] runaway thinking \(28000 tokens, nothing usable\); dropped/);
    // The lane's requests carry a 16384 cap too; tell them apart by their tools.
    assert.equal(requests().filter((r) => !r.tools && r.max_tokens !== 32768).length, 2, 'no retries for a1 or a2');
    assert.equal(readFileSync(one, 'utf8'), `${ALL}\n`);
});

test('race: a check in a copy gets the copy\'s src/ and root first on PYTHONPATH; the real tree\'s check does not', () => {
    const { one, log } = setup();
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'mod.py'), '');
    writeFileSync(join(dir, 'env.mjs'), "console.log('PYTHONPATH=' + process.env.PYTHONPATH);\n");
    const check = `"${process.execPath}" env.mjs && "${process.execPath}" check.mjs`;
    writeFileSync(join(dir, 'routes.json'), JSON.stringify({
        '"tools"': [tools(['read_file', { path: 'one.txt' }])],
        '"max_tokens":16384': [block(one, edit('start', ALL))],
    }));
    const { text, isError } = call({ prompt: 'x', files: [one], check, log_file: log }, [],
        { MOCK_ROUTES: join(dir, 'routes.json'), PYTHONPATH: 'from-env' });
    assert.equal(isError, false, text);
    const seen = readFileSync(log, 'utf8').match(/PYTHONPATH=(.*)/)[1].split(delimiter);
    assert.equal(seen.length, 3, seen.join(' | '));
    assert.match(seen[0], /wgpt-attempt-\w+[/\\]src$/);
    assert.equal(seen[1], dirname(seen[0]));
    assert.equal(seen[2], 'from-env');
});

test('race: every check failing the same way, and a package linked back into the real tree, are warned about', () => {
    const { log } = setup();
    // The code under test lives in lib/, which node_modules links back to: every copy's check runs the real lib.
    mkdirSync(join(dir, 'lib'));
    mkdirSync(join(dir, 'node_modules', '@me'), { recursive: true });
    const lib = join(dir, 'lib', 'index.js');
    writeFileSync(lib, 'export const f = () => 1;\n');
    symlinkSync(join(dir, 'lib'), join(dir, 'node_modules', '@me', 'lib'), 'junction');
    // The same failure every time, only its path and timing differ.
    writeFileSync(join(dir, 'same.mjs'), "console.log(`AssertionError in ${process.cwd()}: f() returned 1 (took ${Math.round(Math.random() * 90) + 10} ms)`);\n" +
        'process.exit(1);\n');
    const check = `"${process.execPath}" same.mjs`;
    writeFileSync(join(dir, 'routes.json'), JSON.stringify({
        '"tools"': [tools(['edit', { path: 'lib/index.js', search: '1', replace: '2' }], ['run_check']),
            tools(['edit', { path: 'lib/index.js', search: '2', replace: '3' }], ['run_check'])],
        '"max_tokens":16384': [block(lib, edit('export const f = () => 1;', 'export const f = () => 4;'))],
    }));
    const { text, isError } = call({ prompt: 'x', files: [lib], check, cwd: dir, max_steps: 2, log_file: log }, [], { MOCK_ROUTES: join(dir, 'routes.json') });
    assert.equal(isError, true);
    assert.match(text, /warning: all 3 check runs failed with the same output, whatever the edits: the check setup may be wrong \(for example, it is not testing the edited copy\)/);
    assert.match(text, /warning: node_modules\/@me\/lib links to .* in the real tree, so a check in a copy that imports "@me\/lib" runs the original lib[/\\]index\.js, not the edits/);
    assert.match(text, /note: the tool loop used all 2 steps; max_steps \(--max-steps\) raises the cap, up to 40\./);
    assert.match(text, /fallback: opencode/);
    const l = readFileSync(log, 'utf8');
    // The probe runs before the first check.
    assert.ok(l.indexOf('!!! WARNING: node_modules/@me/lib') < l.indexOf('AssertionError in'), 'warned before the first check ran');
    assert.match(l, /!!! WARNING: all 3 check runs failed with the same output/);
    assert.equal(readFileSync(lib, 'utf8'), 'export const f = () => 1;\n');
});

test('race: different failures are not blamed on the check', () => {
    const { one, check } = setup();
    writeFileSync(join(dir, 'routes.json'), JSON.stringify({
        '"tools"': [tools(['edit', { path: 'one.txt', search: 'start', replace: 'alpha' }], ['run_check'])],
        '"max_tokens":16384': [block(one, edit('start', 'beta'))],
    }));
    const { text, isError } = call({ prompt: 'x', files: [one], check, max_steps: 1 }, [], { MOCK_ROUTES: join(dir, 'routes.json') });
    assert.equal(isError, true);
    assert.doesNotMatch(text, /same output/);
});
