import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const CLI = resolve(here, '../warriorgpt-ask.mjs');
const MOCK = pathToFileURL(join(here, 'mock-fetch.mjs')).href;

let dir;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'warriorgpt-ask-test-'));
});

function ask(args, { replies = [''], env = {} } = {}) {
    writeFileSync(join(dir, 'replies.json'), JSON.stringify(replies));
    const home = join(dir, 'home');
    mkdirSync(home, { recursive: true });
    const res = spawnSync(process.execPath, ['--import', MOCK, CLI, ...(args.includes('--check') ? ['--parallel', '1'] : []), ...args], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: home, WARRIORGPT_API_KEY: 'test-key',
            CLAUDE_CODE_SESSION_ID: 'test', MOCK_REPLIES: join(dir, 'replies.json'),
            MOCK_REQUEST: join(dir, 'request.json'), WARRIORGPT_RETRY_BASE_MS: '1', ...env },
    });
    const last = res.stdout.trim().split('\n').at(-1);
    return { code: res.status, out: res.stdout, err: res.stderr, json: last ? JSON.parse(last) : null };
}

const block = (path, body) => `=== FILE: ${path} ===\n${body}\n=== END FILE ===`;
const edit = (search, replace) => `<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE`;

function setup() {
    const one = join(dir, 'one.txt');
    writeFileSync(one, 'start\n');
    writeFileSync(join(dir, 'prompt.md'), 'Make one.txt say good.');
    writeFileSync(join(dir, 'check.mjs'), "import { readFileSync } from 'node:fs';\n" +
        "if (!readFileSync(new URL('./one.txt', import.meta.url), 'utf8').includes('good')) process.exit(1);\n");
    return { one, prompt: join(dir, 'prompt.md'), check: `"${process.execPath}" check.mjs` };
}

test('exit 0 when the check passes, with a digest and a JSON line', () => {
    const { one, prompt, check } = setup();
    const r = ask(['--prompt-file', prompt, '--files', one, '--check', check, '--no-loop'],
        { replies: [block(one, edit('start', 'bad')), block(one, edit('bad', 'good'))] });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /check passed on attempt 2 of 3/);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.attempts, 2);
    assert.deepEqual(r.json.tokens, { in: 20, out: 40 });
    assert.deepEqual(r.json.files.map((f) => [f.added, f.removed]), [[1, 1]]);
    assert.equal(readFileSync(one, 'utf8'), 'good\n');
});

test('--no-loop-lane stops the tool-loop lane from racing the one-shot attempts', () => {
    const { one, prompt, check } = setup();
    const reply = block(one, edit('start', 'good'));
    const count = (file) => readFileSync(file, 'utf8').trim().split('\n').length;

    const offLog = join(dir, 'requests-off.jsonl');
    const off = ask(['--prompt-file', prompt, '--files', one, '--check', check, '--no-loop-lane'],
        { replies: [reply], env: { MOCK_REQUEST_LOG: offLog } });
    assert.equal(off.code, 0, off.err);
    assert.match(off.out, /check passed on parallel attempt 1 of 1/);
    assert.equal(off.json.attempts, 1);
    assert.equal(count(offLog), 1, 'with the lane off only the one-shot attempt asks');

    writeFileSync(one, 'start\n');
    const onLog = join(dir, 'requests-on.jsonl');
    const on = ask(['--prompt-file', prompt, '--files', one, '--check', check],
        { replies: [reply, reply], env: { MOCK_REQUEST_LOG: onLog } });
    assert.equal(on.code, 0, on.err);
    assert.ok(count(onLog) > 1, 'by default the lane races the one-shot attempt');
});

test('exit 4 with a fallback hint when the check never passes, with the files restored', () => {
    const { one, prompt, check } = setup();
    const r = ask(['--prompt-file', prompt, '--files', one, '--check', check, '--no-loop', '--max-attempts', '2', '--json'],
        { replies: [block(one, edit('start', 'bad'))] });
    assert.equal(r.code, 4);
    assert.equal(r.out.trim().split('\n').length, 1, 'only the JSON line with --json');
    assert.equal(r.json.ok, false);
    assert.equal(r.json.fallback, 'opencode');
    assert.equal(readFileSync(one, 'utf8'), 'start\n');
});

test('exit 1 when a reply without --check cannot be applied', () => {
    const { one, prompt } = setup();
    const r = ask(['--prompt-file', prompt, '--files', one], { replies: [block(one, edit('missing', 'x'))] });
    assert.equal(r.code, 1);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.fallback, undefined);
    assert.equal(readFileSync(one, 'utf8'), 'start\n');
});

test('exit 2 on usage errors', () => {
    assert.equal(ask([]).code, 2);
    assert.equal(ask(['--bogus']).code, 2);
    assert.equal(ask(['--prompt-file', join(dir, 'missing.md')]).code, 2);
    const r = ask(['--prompt', 'x', '--check', 'npm test']);
    assert.equal(r.code, 2);
    assert.match(r.err, /check needs files/);
});

test('exit 3 when WarriorGPT is unreachable or refuses', () => {
    const { one, prompt } = setup();
    const down = ask(['--prompt-file', prompt, '--files', one], { env: { MOCK_UNREACHABLE: '1' } });
    assert.equal(down.code, 3);
    assert.match(down.err, /unreachable/);
    const refused = ask(['--prompt-file', prompt, '--files', one], { env: { MOCK_STATUS: '503' } });
    assert.equal(refused.code, 3);
    assert.equal(readFileSync(one, 'utf8'), 'start\n');
});

test('comma-separated --files and --context are split', () => {
    const { one, prompt } = setup();
    const two = join(dir, 'two.txt');
    const ctx = join(dir, 'ctx.txt');
    writeFileSync(ctx, 'context body');
    const r = ask(['--prompt-file', prompt, '--files', `${one},${two}`, '--context', ctx],
        { replies: [[block(one, edit('start', 'good')), block(two, 'new')].join('\n')],
            env: { MOCK_REQUEST: join(dir, 'request.json') } });
    assert.equal(r.code, 0, r.err);
    assert.equal(readFileSync(two, 'utf8'), 'new\n');
    assert.match(readFileSync(join(dir, 'request.json'), 'utf8'), /context body/);
});

test('--log keeps every reply and check output', () => {
    const { one, prompt, check } = setup();
    const logFile = join(dir, 'logs', 'attempts.log');
    writeFileSync(join(dir, 'check.mjs'), "import { readFileSync } from 'node:fs';\n" +
        "const t = readFileSync(new URL('./one.txt', import.meta.url), 'utf8');\n" +
        "if (!t.includes('good')) { console.log('CHECK SAW: ' + t.trim()); process.exit(1); }\n");
    const r = ask(['--prompt-file', prompt, '--files', one, '--check', check, '--no-loop', '--max-attempts', '2', '--log', logFile],
        { replies: [block(one, edit('start', 'bad')), 'not a file block at all'] });
    assert.notEqual(r.code, 0);
    const log = readFileSync(logFile, 'utf8');
    assert.match(log, /^=== warriorgpt-ask .* \| check: /);
    assert.match(log, /--- attempt 1: reply \(10 in \/ 20 out, 0 reasoning, finish stop, temperature 0\.6\)\n=== FILE: /);
    assert.match(log, /--- attempt 2: reply \([^)]*temperature 0\.7\)/);
    assert.match(log, /--- attempt 1: check failed \(exit 1\)\nCHECK SAW: bad/);
    assert.match(log, /--- attempt 2: reply[^\n]*\nnot a file block at all/);
    assert.match(log, /--- attempt 2: reply could not be applied/);
    assert.match(log, /=== gave up after 2 attempts/);
});
