// The MCP server's OpenCode lane: start_opencode_job, the shared job tools, and the automatic OpenCode fallback when a
// checked start_warriorgpt_job never passes.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// A check sandbox may set GIT_DIR (Ask-Checked does, for read-only git); these tests make scratch repos, so they drop it.
for (const v of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete process.env[v];

const here = fileURLToPath(new URL('.', import.meta.url));
const SERVER = resolve(here, '../warriorgpt-mcp.mjs');
const MOCK = pathToFileURL(join(here, 'mock-fetch.mjs')).href;
const FAKE = join(here, 'fake-opencode.mjs');
const GIT_ENV = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };

let dir, repo, plain;
const children = [];
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim();
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'warriorgpt-ocmcp-test-'));
    mkdirSync(join(dir, 'config', 'opencode'), { recursive: true });
    repo = join(dir, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q');
    git(repo, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'one.txt'), 'start\n');
    writeFileSync(join(repo, 'check.mjs'), "import { readFileSync } from 'node:fs';\n" +
        "if (!readFileSync(new URL('./one.txt', import.meta.url), 'utf8').includes('good')) process.exit(1);\n");
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');
    plain = join(dir, 'plain');
    mkdirSync(plain);
    writeFileSync(join(plain, 'one.txt'), 'start\n');
    writeFileSync(join(plain, 'check.mjs'), readFileSync(join(repo, 'check.mjs')));
});
afterEach(() => {
    for (const c of children.splice(0)) if (c.exitCode === null) c.kill();
});

// The server as a long-lived child. It runs with the fetch mock preloaded, and the delegate it starts inherits that.
function server(env = {}) {
    const home = join(dir, 'home');
    mkdirSync(home, { recursive: true });
    const child = spawn(process.execPath, ['--import', MOCK, SERVER], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: home, XDG_CONFIG_HOME: join(dir, 'config'),
            WARRIORGPT_API_KEY: 'test-key', CLAUDE_CODE_SESSION_ID: 'test', MOCK_REPLIES: join(dir, 'replies.json'),
            MOCK_STREAM: '1', WARRIORGPT_RETRY_BASE_MS: '1', WARRIORGPT_OPENCODE: FAKE, FAKE_OC_LOG: join(dir, 'oc.json'),
            FAKE_OC: 'done', FAKE_OC_COMMIT: '1', ...GIT_ENV, ...env },
    });
    children.push(child);
    const waiting = new Map();
    createInterface({ input: child.stdout }).on('line', (line) => {
        const msg = JSON.parse(line);
        if (msg.id === undefined) return;
        waiting.get(msg.id)?.(msg);
        waiting.delete(msg.id);
    });
    let id = 0;
    const tool = (name, args) => new Promise((done) => {
        const n = ++id;
        waiting.set(n, (msg) => done(msg.result ? { ...msg.result, text: msg.result.content[0].text } : { rpcError: msg.error, text: '' }));
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    });
    const list = () => new Promise((done) => {
        const n = ++id;
        waiting.set(n, (msg) => done(msg.result.tools));
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method: 'tools/list' }) + '\n');
    });
    const close = () => new Promise((done) => {
        child.on('close', (code) => done(code));
        child.stdin.end();
    });
    return { tool, list, close };
}

const block = (path, body) => `=== FILE: ${path} ===\n${body}\n=== END FILE ===`;
const edit = (search, replace) => `<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE`;
// A checked ask whose every reply fails the check.
function missing(root) {
    const one = join(root, 'one.txt');
    writeFileSync(join(dir, 'replies.json'), JSON.stringify([block(one, edit('start', 'bad'))]));
    return { prompt: 'Make one.txt say good.', files: [one], check: `"${process.execPath}" check.mjs`, cwd: root,
        loop: false, max_attempts: 1, parallel: 1, loop_lane: false };
}
const ocLog = () => JSON.parse(readFileSync(join(dir, 'oc.json'), 'utf8'));
const result = async (s, job_id) => {
    const st = await s.tool('get_warriorgpt_job_status', { job_id, wait_s: 30 });
    assert.match(st.structuredContent.state, /^(done|failed|cancelled)$/, st.text);
    return s.tool('get_warriorgpt_job_result', { job_id });
};

test('start_opencode_job is listed last, and the tool descriptions route work to it', async () => {
    const s = server();
    const tools = await s.list();
    assert.deepEqual(tools.map((t) => t.name), ['ask_warriorgpt', 'start_warriorgpt_job', 'get_warriorgpt_job_status',
        'get_warriorgpt_job_result', 'cancel_warriorgpt_job', 'start_opencode_job']);
    const oc = tools[5];
    for (const p of ['brief', 'dir', 'mode', 'model', 'name', 'reply', 'timeout_min', 'instructions', 'include_uncommitted']) {
        assert.ok(oc.inputSchema.properties[p], p);
    }
    assert.deepEqual(oc.inputSchema.required, ['dir']);
    assert.match(oc.description, /WarriorGPT/);
    assert.match(oc.description, /get_warriorgpt_job_status/);
    assert.match(tools[0].description, /start_opencode_job/);
    assert.ok(tools[1].inputSchema.properties.opencode_fallback, 'start_warriorgpt_job takes opencode_fallback');
    assert.equal(tools[0].inputSchema.properties.opencode_fallback, undefined, 'ask_warriorgpt does not');
    assert.match(tools[2].description, /OpenCode/);
    await s.close();
});

test('start_opencode_job returns at once; the job tools report it; the result carries the branch', async () => {
    const s = server();
    const t0 = Date.now();
    const started = await s.tool('start_opencode_job', { brief: 'Add new.txt.', dir: repo, name: 'oc-mcp' });
    assert.ok(Date.now() - t0 < 1500, 'start does not wait for the worker');
    const { job_id, name } = started.structuredContent;
    assert.match(job_id, /^oc-[0-9a-f]{8}$/);
    assert.equal(name, 'oc-mcp');
    assert.match(started.text, /get_warriorgpt_job_status/);

    const res = await result(s, job_id);
    assert.equal(res.isError, undefined, res.text);
    assert.match(res.text, /# Delegated task oc-mcp/);
    const sc = res.structuredContent;
    assert.equal(sc.ok, true);
    assert.equal(sc.kind, 'opencode');
    assert.equal(sc.exit, 0);
    assert.equal(sc.branch, 'dl/oc-mcp');
    assert.equal(sc.needs_input, false);
    assert.equal(sc.commits.length, 1);
    assert.ok(existsSync(join(sc.worktree, 'new.txt')));

    const all = await s.tool('get_warriorgpt_job_status', {});
    assert.ok(all.structuredContent.jobs.some((j) => j.job_id === job_id && j.state === 'done'));
    await s.close();
});

test('a name is made when none is given', async () => {
    const s = server();
    const started = await s.tool('start_opencode_job', { brief: 'x', dir: repo });
    assert.match(started.structuredContent.name, /^oc-[a-z0-9]{6}$/);
    const res = await result(s, started.structuredContent.job_id);
    assert.equal(res.structuredContent.branch, `dl/${started.structuredContent.name}`);
    await s.close();
});

test('bad arguments fail at start', async () => {
    const s = server();
    for (const args of [{ brief: 'x' }, { brief: 'x', dir: 'relative' }, { brief: 'x', dir: repo, model: 'opencode/big-pickle' }]) {
        const res = await s.tool('start_opencode_job', args);
        assert.equal(res.isError, true, JSON.stringify(args));
    }
    assert.equal(existsSync(join(dir, 'oc.json')), false);
    await s.close();
});

test('NEEDS_INPUT is not an error; a reply continues; no change is an error', async () => {
    const s = server({ FAKE_OC: 'ask' });
    const first = await result(s, (await s.tool('start_opencode_job', { brief: 'x', dir: repo, name: 'oc-q' })).structuredContent.job_id);
    assert.equal(first.isError, undefined, first.text);
    assert.equal(first.structuredContent.needs_input, true);
    assert.equal(first.structuredContent.ok, false);
    assert.match(first.text, /reply/);
    await s.close();

    const s2 = server({ FAKE_OC: 'done' });
    const second = await result(s2, (await s2.tool('start_opencode_job', { name: 'oc-q', dir: repo, reply: 'a' })).structuredContent.job_id);
    assert.equal(second.isError, undefined, second.text);
    assert.equal(second.structuredContent.ok, true);
    await s2.close();

    const s3 = server({ FAKE_OC: 'nochange' });
    const none = await result(s3, (await s3.tool('start_opencode_job', { brief: 'x', dir: repo, name: 'oc-n' })).structuredContent.job_id);
    assert.equal(none.isError, true);
    assert.equal(none.structuredContent.exit, 9);
    await s3.close();
});

test('cancel_warriorgpt_job stops an OpenCode job', async () => {
    const s = server({ FAKE_OC: 'hang' });
    const { job_id } = (await s.tool('start_opencode_job', { brief: 'x', dir: repo, name: 'oc-c' })).structuredContent;
    await new Promise((r) => setTimeout(r, 1500));
    const cancelled = await s.tool('cancel_warriorgpt_job', { job_id });
    const st = await s.tool('get_warriorgpt_job_status', { job_id, wait_s: 20 });
    assert.equal(st.structuredContent.state, 'cancelled', cancelled.text + st.text);
    await s.close();
});

test('a checked job that never passes hands the task to OpenCode', async () => {
    const s = server();
    const args = missing(repo);
    const { job_id } = (await s.tool('start_warriorgpt_job', args)).structuredContent;
    const res = await result(s, job_id);
    assert.equal(res.isError, undefined, res.text);
    assert.match(res.text, /check did not pass/);
    assert.match(res.text, /OpenCode fallback/);
    assert.match(res.text, /# Delegated task fb-/);
    const sc = res.structuredContent;
    assert.equal(sc.ok, true);
    assert.equal(sc.fallback, 'opencode');
    assert.equal(sc.opencode.exit, 0);
    assert.match(sc.opencode.branch, /^dl\/fb-[a-z0-9]{6}$/);
    assert.ok(existsSync(join(sc.opencode.worktree, 'new.txt')));
    assert.equal(readFileSync(join(repo, 'one.txt'), 'utf8'), 'start\n', 'the ask restored its file');
    const brief = ocLog().brief;
    assert.match(brief, /Make one\.txt say good\./);
    assert.match(brief, /one\.txt/);
    assert.ok(brief.includes('check.mjs'), 'the check is in the brief');
    assert.match(brief, /check did not pass/);
    await s.close();
});

test('opencode_fallback: false, a folder outside git, and plain ask_warriorgpt do not start OpenCode', async () => {
    const s = server();
    const off = await result(s, (await s.tool('start_warriorgpt_job', { ...missing(repo), opencode_fallback: false })).structuredContent.job_id);
    assert.equal(off.isError, true);
    assert.equal(off.structuredContent.fallback, 'opencode');
    assert.equal(off.structuredContent.opencode, undefined);

    const outside = await result(s, (await s.tool('start_warriorgpt_job', missing(plain))).structuredContent.job_id);
    assert.equal(outside.isError, true);
    assert.match(outside.text, /not in a git repository/);

    const plainAsk = await s.tool('ask_warriorgpt', missing(repo));
    assert.equal(plainAsk.isError, true);
    assert.match(plainAsk.text, /start_opencode_job/);

    assert.equal(existsSync(join(dir, 'oc.json')), false, 'OpenCode never started');
    await s.close();
});
