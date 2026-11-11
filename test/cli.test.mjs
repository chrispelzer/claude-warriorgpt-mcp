import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
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
    // The lane copies the tree before it asks, so an instant reply can pass and cancel it first (slow Windows
    // runners do); a held-back reply gives the lane time to send its request.
    const on = ask(['--prompt-file', prompt, '--files', one, '--check', check],
        { replies: [{ content: reply, delay_ms: 1500 }], env: { MOCK_REQUEST_LOG: onLog, MOCK_STREAM: '1' } });
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

test('the JSON line carries warnings; a check that fails the same way every time is blamed on the check', () => {
    const { one, prompt } = setup();
    writeFileSync(join(dir, 'same.mjs'), "console.log('cannot import pkg (took ' + Date.now() % 1000 + 'ms)'); process.exit(1);\n");
    const r = ask(['--prompt-file', prompt, '--files', one, '--check', `"${process.execPath}" same.mjs`, '--no-loop', '--max-attempts', '2'],
        { replies: [block(one, edit('start', 'bad')), block(one, edit('bad', 'worse'))] });
    assert.equal(r.code, 4);
    assert.match(r.out, /warning: all 2 check runs failed with the same output/);
    assert.equal(r.json.warnings.length, 1);
    assert.match(r.json.warnings[0], /the check setup may be wrong/);
});

test('a check that times out says how to give it longer', () => {
    const { one, prompt } = setup();
    writeFileSync(join(dir, 'slow.mjs'), 'setTimeout(() => {}, 5000);\n');
    const r = ask(['--prompt-file', prompt, '--files', one, '--check', `"${process.execPath}" slow.mjs`, '--no-loop', '--max-attempts', '1',
        '--check-timeout', '1'], { replies: [block(one, edit('start', 'good'))] });
    assert.equal(r.code, 4);
    assert.match(r.out, /Last check timed out after 1s/);
    assert.match(r.out, /note: the check timed out after 1 s; check_timeout_s \(--check-timeout\) raises it, up to 3600\./);
    assert.equal(r.json.warnings, undefined, 'one run is not a pattern');
});

test('a request over the context window stops at once with what to change, and leaves the files alone', () => {
    const { one, prompt, check } = setup();
    const env = { MOCK_STATUS: '400', MOCK_ERROR_BODY: '{"error":{"code":"context_length_exceeded","message":"too many tokens"}}' };
    for (const extra of [[], ['--no-loop']]) {
        const r = ask(['--prompt-file', prompt, '--files', one, '--check', check, ...extra], { env });
        assert.equal(r.code, 2, r.err);
        assert.match(r.err, /The request is over local\.qwen3\.8-27b's context window; attach fewer or smaller context_files, list fewer files, or split the task/);
        assert.equal(readFileSync(one, 'utf8'), 'start\n');
    }
});

test('a check whose program does not exist from cwd stops before anything is sent (exit 2)', () => {
    const { one, prompt } = setup();
    const log = join(dir, 'run.log');
    const r = ask(['--prompt-file', prompt, '--files', one, '--check', '.venv/bin/python -m unittest', '--log', log], { replies: [block(one, edit('start', 'good'))] });
    assert.equal(r.code, 2);
    assert.match(r.err, /the check command could not run from .*: \.venv\/bin\/python not found; fix the check or pass cwd/);
    assert.equal(existsSync(join(dir, 'request.json')), false, 'no request was sent');
    assert.equal(readFileSync(one, 'utf8'), 'start\n');
    assert.match(readFileSync(log, 'utf8'), /=== stopped: \.venv\/bin\/python not found/);
});

test('by default the check runs in the project root above the files, and the log says so', () => {
    writeFileSync(join(dir, 'pyproject.toml'), '');
    mkdirSync(join(dir, 'src', 'pkg'), { recursive: true });
    const mod = join(dir, 'src', 'pkg', 'mod.txt');
    writeFileSync(mod, 'start\n');
    writeFileSync(join(dir, 'prompt.md'), 'Make mod.txt say good.');
    writeFileSync(join(dir, 'check.mjs'), "import { readFileSync } from 'node:fs';\nconsole.log('ran in ' + process.cwd());\n" +
        "if (!readFileSync('src/pkg/mod.txt', 'utf8').includes('good')) process.exit(1);\n");
    const log = join(dir, 'run.log');
    const r = ask(['--prompt-file', join(dir, 'prompt.md'), '--files', mod, '--check', `"${process.execPath}" check.mjs`, '--no-loop',
        '--log', log], { replies: [block(mod, edit('start', 'good'))] });
    assert.equal(r.code, 0, r.out + r.err);
    const l = readFileSync(log, 'utf8');
    assert.ok(l.split('\n')[0].endsWith(`| cwd: ${dir}`), l.split('\n')[0]);
    assert.match(l, /\ncwd: the project root, the nearest folder above the files with pyproject\.toml\n/);
});

test('a check whose program cannot start stops every attempt at once (exit 2), files restored', { skip: process.platform === 'win32' && 'needs a POSIX shell' }, () => {
    const { one, prompt } = setup();
    writeFileSync(join(dir, 'run-tests'), '#!/bin/sh\nexit 0\n', { mode: 0o644 }); // not executable: the shell says 126
    const log = join(dir, 'run.log');
    const r = ask(['--prompt-file', prompt, '--files', one, '--check', './run-tests', '--cwd', dir, '--log', log],
        { replies: [block(one, edit('start', 'good')), { tool_calls: [{ name: 'run_check', arguments: {} }] }],
            env: { MOCK_REQUEST_LOG: join(dir, 'requests.jsonl') } });
    assert.equal(r.code, 2, r.out + r.err);
    assert.match(r.err, /the check command could not run from .*: .*run-tests: Permission denied; fix the check or pass cwd/);
    assert.equal(readFileSync(one, 'utf8'), 'start\n');
    assert.ok(readFileSync(join(dir, 'requests.jsonl'), 'utf8').trim().split('\n').length <= 3, 'stopped, not sent to fix it');
    assert.match(readFileSync(log, 'utf8'), /!!! the check command could not run: .*Permission denied; stopping/);
});

test('in the tool loop, a check that stops being able to run is a setup problem, not a step to fix', { skip: process.platform === 'win32' && 'needs a POSIX shell' }, () => {
    const { one, prompt } = setup();
    // Runs once (a normal failure), then takes away its own exec bit.
    writeFileSync(join(dir, 'run-tests'), '#!/bin/sh\nchmod -x "$0"\necho "1 test failed"\nexit 1\n', { mode: 0o755 });
    const r = ask(['--prompt-file', prompt, '--files', one, '--check', './run-tests', '--cwd', dir, '--no-loop-lane'],
        // The one-shot is checked in a copy; in the real tree the loop's first run is a normal failure, its second cannot start.
        { replies: [block(one, edit('start', 'bad')), { tool_calls: [{ name: 'run_check', arguments: {} }] },
            { tool_calls: [{ name: 'run_check', arguments: {} }] },
            { tool_calls: [{ name: 'edit', arguments: { path: 'one.txt', search: 'bad', replace: 'good' } }] }],
            env: { MOCK_REQUEST_LOG: join(dir, 'requests.jsonl') } });
    assert.equal(r.code, 2, r.out + r.err);
    assert.match(r.err, /could not run from .*Permission denied/);
    assert.equal(readFileSync(join(dir, 'requests.jsonl'), 'utf8').trim().split('\n').length, 3, 'no step after the broken run');
    assert.equal(readFileSync(one, 'utf8'), 'start\n', 'the one-shot edit was restored');
});

test('a check in the real tree also gets the tree\'s src/ first on PYTHONPATH', () => {
    const { one, prompt } = setup();
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'seen.mjs'), "import { readFileSync, appendFileSync } from 'node:fs';\n" +
        "appendFileSync(new URL('./seen.txt', import.meta.url), (process.env.PYTHONPATH || '') + '\\n');\n" +
        "if (!readFileSync(new URL('./one.txt', import.meta.url), 'utf8').includes('good')) process.exit(1);\n");
    const r = ask(['--prompt-file', prompt, '--files', one, '--check', `"${process.execPath}" seen.mjs`, '--no-loop', '--cwd', dir],
        { replies: [block(one, edit('start', 'good'))], env: { PYTHONPATH: '/elsewhere' } });
    assert.equal(r.code, 0, r.err);
    const seen = readFileSync(join(dir, 'seen.txt'), 'utf8').trim().split('\n');
    assert.ok(seen.length > 0);
    for (const line of seen) {
        assert.deepEqual(line.split(process.platform === 'win32' ? ';' : ':'), [join(dir, 'src'), dir, '/elsewhere'],
            'every check run, including the one in the real tree, tests this tree first');
    }
});
