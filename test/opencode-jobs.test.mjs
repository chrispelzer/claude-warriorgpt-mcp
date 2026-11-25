// runOpenCode runs warriorgpt-delegate (the sealed OpenCode worker) as a child process, for the MCP server's
// start_opencode_job and for the automatic fallback when a checked ask never passes.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runOpenCode, snapshotBase, fallbackBrief, taskName } from '../opencode-jobs.mjs';
import { CancelledError, UsageError } from '../ask.mjs';

// A check sandbox may set GIT_DIR (Ask-Checked does, for read-only git); these tests make scratch repos, so they drop it.
for (const v of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete process.env[v];

const here = fileURLToPath(new URL('.', import.meta.url));
const MOCK = pathToFileURL(join(here, 'mock-fetch.mjs')).href;
const FAKE = join(here, 'fake-opencode.mjs');
const GIT_ENV = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };

let dir, home, repo, plain;
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim();
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'warriorgpt-ocjobs-test-'));
    home = join(dir, 'home');
    mkdirSync(home);
    mkdirSync(join(dir, 'config', 'opencode'), { recursive: true });
    repo = join(dir, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q');
    git(repo, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'calc.py'), 'def add(a, b):\n    return a + b\n');
    writeFileSync(join(repo, '.gitignore'), 'secret.env\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');
    plain = join(dir, 'plain');
    mkdirSync(plain);
    writeFileSync(join(plain, 'a.txt'), 'a\n');
});

// The delegate child gets the mock fetch (for its probe) and the fake OpenCode, and keeps its state in the test home.
const opts = (env = {}) => ({
    nodeArgs: ['--import', MOCK],
    env: { HOME: home, USERPROFILE: home, LOCALAPPDATA: home, XDG_CONFIG_HOME: join(dir, 'config'),
        WARRIORGPT_API_KEY: 'test-key', CLAUDE_CODE_SESSION_ID: 'test', WARRIORGPT_OPENCODE: FAKE,
        FAKE_OC_LOG: join(dir, 'oc.json'), ...GIT_ENV, ...env },
});
const ocLog = () => JSON.parse(readFileSync(join(dir, 'oc.json'), 'utf8'));
const after = (argv, flag) => argv[argv.indexOf(flag) + 1];
const status = (cwd) => git(cwd, 'status', '--porcelain', '--untracked-files=all');

test('a write task runs on a dl/ branch and the result says how to review it', async () => {
    const lines = [];
    const res = await runOpenCode({ brief: 'Add new.txt.', dir: repo, name: 'oc-one' },
        { onLog: (l) => lines.push(l) }, opts({ FAKE_OC: 'done', FAKE_OC_COMMIT: '1' }));
    assert.equal(res.ok, true, res.text);
    assert.equal(res.exit, 0);
    assert.equal(res.kind, 'opencode');
    assert.equal(res.name, 'oc-one');
    assert.equal(res.status, 'DONE');
    assert.equal(res.needs_input, false);
    assert.equal(res.branch, 'dl/oc-one');
    assert.equal(res.commits.length, 1);
    assert.ok(existsSync(join(res.worktree, 'new.txt')));
    assert.ok(existsSync(join(res.run_dir, 'summary.json')));
    assert.equal(res.base_sha, git(repo, 'rev-parse', 'HEAD'));
    assert.match(res.text, /# Delegated task oc-one/);
    assert.match(res.text, /Review the diff/);
    assert.ok(res.text.includes(`diff ${res.base_sha}..HEAD`), res.text);
    assert.doesNotMatch(res.text, /cherry-pick/);
    assert.ok(lines.join('\n').includes('warriorgpt-delegate: oc-one ->'), 'the delegate output reaches onLog');
    assert.match(ocLog().brief, /Add new\.txt\./);
    assert.equal(existsSync(join(repo, 'new.txt')), false, 'the main checkout is untouched');
});

test('NEEDS_INPUT is not an error, and a reply resumes the same session', async () => {
    const first = await runOpenCode({ brief: 'Pick one.', dir: repo, name: 'oc-ask' }, {}, opts({ FAKE_OC: 'ask' }));
    assert.equal(first.ok, false);
    assert.equal(first.exit, 4);
    assert.equal(first.needs_input, true);
    assert.match(first.text, /a or b\?/);
    assert.match(first.text, /reply/);
    assert.ok(first.text.includes('oc-ask'));

    const second = await runOpenCode({ name: 'oc-ask', dir: repo, reply: 'Use a.' }, {},
        opts({ FAKE_OC: 'done', FAKE_OC_COMMIT: '1' }));
    assert.equal(second.ok, true, second.text);
    const log = ocLog();
    assert.equal(after(log.argv, '-s'), 'ses_fake');
    assert.match(log.brief, /Use a\./);
});

test('bad arguments are a UsageError and start nothing', async () => {
    const bad = [
        {},
        { brief: 'x' },
        { brief: '', dir: repo },
        { brief: 'x', dir: 'relative/dir' },
        { brief: 'x', dir: join(dir, 'missing') },
        { brief: 'x', dir: repo, mode: 'edit' },
        { brief: 'x', dir: repo, name: 'Bad Name' },
        { dir: repo, reply: 'yes' },
        { brief: 'x', dir: repo, model: 'opencode/big-pickle' },
        { brief: 'x', dir: repo, model: 'anthropic/claude-haiku-4-5' },
        { brief: 'x', dir: repo, timeout_min: 0 },
        { brief: 'x', dir: repo, timeout_min: 500 },
        { brief: 'x', dir: repo, instructions: ['relative.md'] },
    ];
    for (const args of bad) {
        await assert.rejects(runOpenCode(args, {}, opts({ FAKE_OC: 'done' })), UsageError, JSON.stringify(args));
    }
    assert.equal(existsSync(join(dir, 'oc.json')), false, 'OpenCode never started');
});

test('WarriorGPT models pass with or without the prefix', async () => {
    const res = await runOpenCode({ brief: 'x', dir: repo, name: 'oc-model', model: 'local.gpt-oss-120b' }, {},
        opts({ FAKE_OC: 'done', FAKE_OC_COMMIT: '1' }));
    assert.equal(res.ok, true, res.text);
    assert.equal(after(ocLog().argv, '-m'), 'warriorgpt/local.gpt-oss-120b');
});

test('uncommitted and untracked work goes along by default; the user tree, index and stash are untouched', async () => {
    writeFileSync(join(repo, 'calc.py'), 'def add(a, b):\n    return a + b + 0\n');
    writeFileSync(join(repo, 'test_new.py'), 'from calc import add\n');
    writeFileSync(join(repo, 'secret.env'), 'TOKEN=1\n');
    const head = git(repo, 'rev-parse', 'HEAD');
    const before = status(repo);

    const res = await runOpenCode({ brief: 'x', dir: repo, name: 'oc-dirty' }, {}, opts({ FAKE_OC: 'done', FAKE_OC_COMMIT: '1' }));
    assert.equal(res.ok, true, res.text);
    assert.notEqual(res.base_sha, head, 'the base is a snapshot commit');
    assert.equal(git(repo, 'rev-parse', `${res.base_sha}^`), head, 'the snapshot sits on HEAD');
    assert.ok(existsSync(join(res.worktree, 'test_new.py')), 'untracked file in the worktree');
    assert.match(readFileSync(join(res.worktree, 'calc.py'), 'utf8'), /\+ 0/);
    assert.equal(existsSync(join(res.worktree, 'secret.env')), false, 'ignored files stay out');
    assert.ok(res.text.includes(`git cherry-pick ${res.base_sha}..dl/oc-dirty`), res.text);

    assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
    assert.equal(status(repo), before);
    assert.equal(git(repo, 'diff', '--cached', '--name-only'), '');
    assert.equal(git(repo, 'stash', 'list'), '');
});

test('include_uncommitted: false starts from HEAD', async () => {
    writeFileSync(join(repo, 'test_new.py'), 'x\n');
    const res = await runOpenCode({ brief: 'x', dir: repo, name: 'oc-head', include_uncommitted: false }, {},
        opts({ FAKE_OC: 'done', FAKE_OC_COMMIT: '1' }));
    assert.equal(res.ok, true, res.text);
    assert.equal(res.base_sha, git(repo, 'rev-parse', 'HEAD'));
    assert.equal(existsSync(join(res.worktree, 'test_new.py')), false);
});

test('snapshotBase: null outside git and on a clean tree; a commit on HEAD otherwise', () => {
    assert.equal(snapshotBase(plain), null);
    assert.equal(snapshotBase(repo), null);
    writeFileSync(join(repo, 'new.py'), 'x\n');
    const before = status(repo);
    const sha = snapshotBase(repo);
    assert.match(sha, /^[0-9a-f]{40}$/);
    assert.equal(git(repo, 'rev-parse', `${sha}^`), git(repo, 'rev-parse', 'HEAD'));
    assert.match(git(repo, 'show', '--name-only', '--format=', sha), /new\.py/);
    assert.equal(status(repo), before);
    // From a subfolder of the repository too.
    mkdirSync(join(repo, 'sub'));
    writeFileSync(join(repo, 'sub', 'b.py'), 'y\n');
    assert.match(snapshotBase(join(repo, 'sub')), /^[0-9a-f]{40}$/);
});

test('a read task outside git answers in place', async () => {
    const res = await runOpenCode({ brief: 'What is in a.txt?', dir: plain, mode: 'read', name: 'oc-read' }, {},
        opts({ FAKE_OC: 'answer' }));
    assert.equal(res.ok, true, res.text);
    assert.equal(res.branch, null);
    assert.match(res.text, /calc\.py:1 defines add/);
    assert.equal(after(ocLog().argv, '--agent'), 'delegate-reader');
});

test('no change made is exit 9 and not ok', async () => {
    const res = await runOpenCode({ brief: 'x', dir: repo, name: 'oc-none' }, {}, opts({ FAKE_OC: 'nochange' }));
    assert.equal(res.ok, false);
    assert.equal(res.exit, 9);
    assert.match(res.text, /no change/i);
});

test('cancel stops the worker and rejects with CancelledError', async () => {
    const ctl = new AbortController();
    const t0 = Date.now();
    const run = runOpenCode({ brief: 'x', dir: repo, name: 'oc-hang' }, { signal: ctl.signal }, opts({ FAKE_OC: 'hang' }));
    setTimeout(() => ctl.abort(), 1500);
    await assert.rejects(run, CancelledError);
    assert.ok(Date.now() - t0 < 20_000, 'stopped promptly');
});

test('taskName makes a valid fresh name', () => {
    const a = taskName('fb');
    assert.match(a, /^fb-[a-z0-9]{6}$/);
    assert.notEqual(a, taskName('fb'));
    assert.match(taskName(), /^oc-[a-z0-9]{6}$/);
});

test('fallbackBrief carries the task, the files, the check and the last failure', () => {
    const files = [join(repo, 'src', 'semver.js'), join(repo, 'test', 'semver.test.mjs')];
    const failure = 'check did not pass in 3 attempts. ' + 'x'.repeat(10_000);
    const brief = fallbackBrief({ prompt: 'Implement satisfies().', files, check: 'node --test', cwd: join(repo, 'test'),
        root: repo, failure });
    assert.match(brief, /Implement satisfies\(\)\./);
    assert.match(brief, /src\/semver\.js/);
    assert.match(brief, /test\/semver\.test\.mjs/);
    assert.ok(!brief.includes(repo), 'paths are relative to the repository');
    assert.match(brief, /node --test/);
    assert.match(brief, /from `test`/);
    assert.match(brief, /[Cc]ommit/);
    assert.match(brief, /check did not pass in 3 attempts/);
    assert.ok(brief.length < 7000, `failure text is cut (${brief.length})`);
    // The check runs from the repository root: no folder note.
    assert.doesNotMatch(fallbackBrief({ prompt: 'p', files, check: 'npm test', cwd: repo, root: repo, failure: 'f' }), /from `/);
});
