import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const RUNNER = resolve(here, '../warriorgpt-delegate.mjs');
const MOCK = pathToFileURL(join(here, 'mock-fetch.mjs')).href;
const FAKE = join(here, 'fake-opencode.mjs');
const GIT_ENV = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };

let dir, home, repo, plain, brief;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'warriorgpt-delegate-test-'));
    home = join(dir, 'home');
    mkdirSync(home);
    mkdirSync(join(dir, 'config', 'opencode'), { recursive: true });
    writeFileSync(join(dir, 'config', 'opencode', 'opencode.json'),
        JSON.stringify({ providers: { warriorgpt: { name: 'WarriorGPT' } }, plugins: ['x'] }));
    repo = join(dir, 'repo');
    mkdirSync(repo);
    const git = (...args) => execFileSync('git', args, { cwd: repo, env: { ...process.env, ...GIT_ENV } });
    git('init', '-q');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'calc.py'), 'def add(a, b):\n    return a + b\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    plain = join(dir, 'plain');
    mkdirSync(plain);
    writeFileSync(join(plain, 'a.txt'), 'a\n');
    brief = join(dir, 'brief.md');
    writeFileSync(brief, 'Do the thing.\n');
});

function run(args, env = {}) {
    return spawnSync(process.execPath, ['--import', MOCK, RUNNER, ...args], {
        encoding: 'utf8',
        cwd: dir,
        env: { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: home,
            XDG_CONFIG_HOME: join(dir, 'config'), WARRIORGPT_API_KEY: 'test-key', CLAUDE_CODE_SESSION_ID: 'test',
            WARRIORGPT_OPENCODE: FAKE, FAKE_OC_LOG: join(dir, 'oc.json'), ...GIT_ENV, ...env },
    });
}

const stateDir = () => process.platform === 'win32' ? join(home, 'warriorgpt-mcp') : join(home, '.local/share/warriorgpt-mcp');
const summary = (folder, name) => JSON.parse(readFileSync(join(stateDir(), 'runs', folder, name, 'summary.json'), 'utf8'));
const ocLog = () => JSON.parse(readFileSync(join(dir, 'oc.json'), 'utf8'));
const after = (argv, flag) => argv[argv.indexOf(flag) + 1];

test('write mode commits on a dl/ branch in a worktree', () => {
    const res = run(['--name', 't1', '--brief', brief, '--dir', repo], { FAKE_OC: 'done', FAKE_OC_COMMIT: '1' });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const worktree = join(stateDir(), 'worktrees', 'repo-t1');
    assert.match(execFileSync('git', ['-C', repo, 'branch', '--list', 'dl/t1'], { encoding: 'utf8' }), /dl\/t1/);
    assert.equal(existsSync(join(repo, 'new.txt')), false);
    assert.equal(existsSync(join(worktree, 'new.txt')), true);

    const log = ocLog();
    assert.equal(realpathSync(log.pwd), realpathSync(worktree));
    assert.ok(log.argv.includes('--standalone'));
    assert.equal(after(log.argv, '--agent'), 'delegate-worker');
    assert.match(log.brief, /Do the thing\./);
    assert.match(log.brief, /Branch: dl\/t1/);
    assert.ok(log.config.providers.warriorgpt);
    assert.equal(log.config.plugins, undefined);
    assert.match(log.config.instructions[0], /WORKER_RULES\.md$/);

    const s = summary('repo', 't1');
    assert.equal(s.exit, 0);
    assert.equal(s.status, 'DONE');
    assert.equal(s.commits.length, 1);
});

test('exit 9 when write mode makes no commit', () => {
    assert.equal(run(['--name', 't2', '--brief', brief, '--dir', repo], { FAKE_OC: 'nochange' }).status, 9);
});

test('exit 4 on NEEDS_INPUT, and --continue --resume reuses the session', () => {
    const first = run(['--name', 't3', '--brief', brief, '--dir', repo], { FAKE_OC: 'ask' });
    assert.equal(first.status, 4);
    assert.match(first.stdout, /NEEDS_INPUT/);

    const second = run(['--name', 't3', '--brief', brief, '--dir', repo, '--continue', '--resume'],
        { FAKE_OC: 'done', FAKE_OC_COMMIT: '1' });
    assert.equal(second.status, 0, second.stdout);
    const log = ocLog();
    assert.equal(after(log.argv, '-s'), 'ses_fake');
    assert.match(log.brief, /The lead's reply/);
});

test('read mode outside git reports changed files', () => {
    const res = run(['--name', 't4', '--mode', 'read', '--brief', brief, '--dir', plain], { FAKE_OC: 'partial' });
    assert.equal(res.status, 10);
    assert.ok(summary('plain', 't4').changed.includes('added    new.txt'));
    assert.equal(after(ocLog().argv, '--agent'), 'delegate-reader');
});

test('read mode answer without HANDOFF is accepted', () => {
    assert.equal(run(['--name', 't5', '--mode', 'read', '--brief', brief, '--dir', plain], { FAKE_OC: 'answer' }).status, 0);
});

test('exit 3 when the model does not answer', () => {
    const res = run(['--name', 't6', '--brief', brief, '--dir', repo], { MOCK_STATUS: '500', FAKE_OC: 'done' });
    assert.equal(res.status, 3);
    assert.match(res.stdout, /does not answer/);
    assert.equal(existsSync(join(dir, 'oc.json')), false);
});

test('exit 8 on timeout', () => {
    assert.equal(run(['--name', 't7', '--brief', brief, '--dir', repo, '--timeout', '0.02'], { FAKE_OC: 'hang' }).status, 8);
});

test('usage errors exit 2', () => {
    assert.equal(run(['--name', 'Bad Name', '--brief', brief, '--dir', repo]).status, 2);
    assert.equal(run(['--bogus']).status, 2);
});

test('usage log records the run', () => {
    run(['--name', 't9', '--brief', brief, '--dir', repo], { FAKE_OC: 'done', FAKE_OC_COMMIT: '1' });
    const last = JSON.parse(readFileSync(join(stateDir(), 'usage.jsonl'), 'utf8').trim().split('\n').at(-1));
    assert.equal(last.in, 100);
    assert.equal(last.out, 25);
    assert.equal(last.via, 'opencode');
    assert.equal(last.session, 'test');
});
