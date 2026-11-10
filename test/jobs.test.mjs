// Checked tasks as background jobs: start returns at once, status and result are polled, cancel restores the files.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createJobs } from '../jobs.mjs';
import { CancelledError } from '../ask.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const SERVER = resolve(here, '../warriorgpt-mcp.mjs');
const MOCK = pathToFileURL(join(here, 'mock-fetch.mjs')).href;

let dir;
const children = [];
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'warriorgpt-jobs-test-'));
});
// A test that failed half way must not leave its server running (it would hold the test run open).
afterEach(() => {
    for (const c of children.splice(0)) if (c.exitCode === null) c.kill();
});

const pause = (ms) => new Promise((done) => setTimeout(done, ms));

// A run that waits for its gate, logs a step, and honours the signal as runAsk does.
function fakeRun() {
    const gates = [];
    const run = (args, { signal, onLog }) => new Promise((done, fail) => {
        onLog('=== 1 parallel first attempt\n--- attempt 1: reply (10 in / 20 out)');
        onLog('[loop] --- fix step 3 of 30: (1 in / 2 out)');
        signal.addEventListener('abort', () => fail(new CancelledError('cancelled')), { once: true });
        gates.push(() => done({ ok: true, text: `did ${args.prompt}`, attempts: 1, usage: {}, files: [] }));
    });
    return { run, open: () => gates.shift()() };
}

test('jobs: start runs at once, progress comes from the log, the result is kept', async () => {
    const { run, open } = fakeRun();
    const jobs = createJobs({ run, maxRunning: 2 });
    const job = jobs.start({ prompt: 'a' });
    await pause(0);
    assert.equal(job.state, 'running');
    assert.deepEqual(job.progress, { replies: 1, step: 'loop lane fix step 3 of 30', retries: 0, phase: '1 parallel first attempt' });
    assert.ok(job.log.includes('--- attempt 1: reply (10 in / 20 out)'));
    open();
    await jobs.wait(job, 1000);
    assert.equal(job.state, 'done');
    assert.equal(job.result.text, 'did a');
    assert.equal(jobs.get(job.id), job);
});

test('jobs: past maxRunning they queue, and start in turn', async () => {
    const { run, open } = fakeRun();
    const jobs = createJobs({ run, maxRunning: 1 });
    const a = jobs.start({ prompt: 'a' });
    const b = jobs.start({ prompt: 'b' });
    await pause(0);
    assert.deepEqual([a.state, b.state], ['running', 'queued']);
    open();
    await jobs.wait(a, 1000);
    await pause(0);
    assert.equal(b.state, 'running');
    open();
    await jobs.wait(b, 1000);
    assert.equal(b.result.text, 'did b');
});

test('jobs: cancel stops a running job through its signal, and drops a queued one', async () => {
    const { run } = fakeRun();
    const jobs = createJobs({ run, maxRunning: 1 });
    const a = jobs.start({ prompt: 'a' });
    const b = jobs.start({ prompt: 'b' });
    await pause(0);
    jobs.cancel(b);
    assert.equal(b.state, 'cancelled');
    jobs.cancel(a);
    await jobs.wait(a, 1000);
    assert.equal(a.state, 'cancelled');
    assert.ok(a.error instanceof CancelledError);
});

test('jobs: a run that throws is failed; finished jobs are dropped after keepMs', async () => {
    let t = 1000;
    const jobs = createJobs({ run: async () => { throw new Error('boom'); }, keepMs: 500, now: () => t });
    const job = jobs.start({ prompt: 'a' });
    await jobs.wait(job, 1000);
    assert.equal(job.state, 'failed');
    assert.equal(job.error.message, 'boom');
    t += 499;
    assert.equal(jobs.get(job.id), job);
    t += 2;
    assert.equal(jobs.get(job.id), null);
});

// The server as a long-lived child: requests go in one at a time, as a client sends them.
function server(env = {}) {
    const home = join(dir, 'home');
    mkdirSync(home, { recursive: true });
    const child = spawn(process.execPath, ['--import', MOCK, SERVER], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: home, WARRIORGPT_API_KEY: 'test-key',
            CLAUDE_CODE_SESSION_ID: 'test', MOCK_REPLIES: join(dir, 'replies.json'), MOCK_STREAM: '1',
            WARRIORGPT_RETRY_BASE_MS: '1', ...env },
    });
    children.push(child);
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    const waiting = new Map();
    createInterface({ input: child.stdout }).on('line', (line) => {
        const msg = JSON.parse(line);
        waiting.get(msg.id)?.(msg);
        waiting.delete(msg.id);
    });
    let id = 0;
    const tool = (name, args) => new Promise((done) => {
        const n = ++id;
        waiting.set(n, (msg) => done(msg.result ? { ...msg.result, text: msg.result.content[0].text } : { rpcError: msg.error, text: '' }));
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    });
    const close = () => new Promise((done) => {
        child.on('close', (code) => done({ code, stderr }));
        child.stdin.end();
    });
    return { tool, close };
}

const block = (path, body) => `=== FILE: ${path} ===\n${body}\n=== END FILE ===`;
const edit = (search, replace) => `<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE`;
function setup(replies) {
    const one = join(dir, 'one.txt');
    writeFileSync(one, 'start\n');
    writeFileSync(join(dir, 'check.mjs'), "import { readFileSync } from 'node:fs';\n" +
        "if (!readFileSync(new URL('./one.txt', import.meta.url), 'utf8').includes('good')) process.exit(1);\n");
    writeFileSync(join(dir, 'replies.json'), JSON.stringify(replies(one)));
    return { one, args: { prompt: 'Make one.txt say good.', files: [one], check: `"${process.execPath}" check.mjs`, cwd: dir,
        loop: false, max_attempts: 3 } };
}

test('server: the job tools are listed, and ask_warriorgpt points checked work at them', async () => {
    const list = await new Promise((done) => {
        const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'ignore'] });
        children.push(child);
        createInterface({ input: child.stdout }).once('line', (l) => { done(JSON.parse(l).result.tools); child.stdin.end(); });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
    });
    assert.deepEqual(list.map((t) => t.name), ['ask_warriorgpt', 'start_warriorgpt_job', 'get_warriorgpt_job_status',
        'get_warriorgpt_job_result', 'cancel_warriorgpt_job']);
    assert.match(list[0].description, /start_warriorgpt_job/);
    assert.match(list[2].description, /30 s/);
    assert.deepEqual(list[1].inputSchema, list[0].inputSchema);
});

test('server: start returns a job id at once; status shows progress; result has ask_warriorgpt\'s shape', async () => {
    const { one, args } = setup((one) => [block(one, edit('start', 'bad')), { content: block(one, edit('bad', 'good')), delay_ms: 600 }]);
    const s = server();
    const t0 = Date.now();
    const started = await s.tool('start_warriorgpt_job', args);
    assert.ok(Date.now() - t0 < 500, 'start does not wait for the run');
    const jobId = started.structuredContent.job_id;
    assert.match(jobId, /^wgpt-[0-9a-f]{8}$/);
    assert.match(started.text, /get_warriorgpt_job_status/);

    const early = await s.tool('get_warriorgpt_job_result', { job_id: jobId });
    assert.equal(early.isError, undefined);
    assert.match(early.text, /^Not finished yet/);

    await pause(300);
    const running = await s.tool('get_warriorgpt_job_status', { job_id: jobId });
    assert.equal(running.structuredContent.state, 'running');
    assert.equal(running.structuredContent.next_poll_s, 15);
    assert.ok(running.structuredContent.progress.replies >= 1);
    assert.ok(running.structuredContent.log_tail.some((l) => /attempt 1: check failed/.test(l)), running.text);

    const done = await s.tool('get_warriorgpt_job_status', { job_id: jobId, wait_s: 10 });
    assert.equal(done.structuredContent.state, 'done', done.text);
    assert.match(done.text, /get_warriorgpt_job_result/);
    const result = await s.tool('get_warriorgpt_job_result', { job_id: jobId });
    assert.equal(result.isError, undefined);
    assert.match(result.text, /check passed on attempt 2 of 3/);
    assert.equal(readFileSync(one, 'utf8'), 'good\n');

    const all = await s.tool('get_warriorgpt_job_status', {});
    assert.deepEqual(all.structuredContent.jobs.map((j) => [j.job_id, j.state]), [[jobId, 'done']]);
    assert.equal((await s.close()).code, 0);
});

test('server: cancel stops the run and restores the files', async () => {
    const { one, args } = setup((one) => [block(one, edit('start', 'bad')), { content: block(one, edit('bad', 'good')), delay_ms: 30_000 }]);
    const s = server();
    const { structuredContent: { job_id } } = await s.tool('start_warriorgpt_job', args);
    for (let i = 0; i < 50 && readFileSync(one, 'utf8') !== 'bad\n'; i++) await pause(50);
    assert.equal(readFileSync(one, 'utf8'), 'bad\n', 'attempt 1 was written');
    const t0 = Date.now();
    const cancelled = await s.tool('cancel_warriorgpt_job', { job_id });
    assert.equal(cancelled.structuredContent.state, 'cancelled', cancelled.text);
    assert.ok(Date.now() - t0 < 5000);
    assert.equal(readFileSync(one, 'utf8'), 'start\n');
    const result = await s.tool('get_warriorgpt_job_result', { job_id });
    assert.equal(result.isError, true);
    assert.match(result.text, /cancelled; every file it could change is back/);
    assert.equal((await s.close()).code, 0);
});

test('server: cancel during the race stops every attempt and the loop lane at once', async () => {
    const { one, args } = setup((one) => [{ content: block(one, edit('start', 'good')), delay_ms: 30_000 }]);
    const s = server({ MOCK_REQUEST_LOG: join(dir, 'requests.jsonl'), MOCK_REQUEST: join(dir, 'request.json') });
    const { structuredContent: { job_id } } = await s.tool('start_warriorgpt_job', { ...args, loop: true, parallel: 2, loop_lane: true });
    const sent = () => { try { return readFileSync(join(dir, 'requests.jsonl'), 'utf8').trim().split('\n').length; } catch { return 0; } };
    for (let i = 0; i < 100 && sent() < 3; i++) await pause(50);
    assert.equal(sent(), 3, 'two one-shot attempts and the loop lane are in flight');
    const t0 = Date.now();
    const cancelled = await s.tool('cancel_warriorgpt_job', { job_id });
    assert.equal(cancelled.structuredContent.state, 'cancelled', cancelled.text);
    assert.ok(Date.now() - t0 < 5000);
    assert.equal(readFileSync(one, 'utf8'), 'start\n');
    assert.equal(sent(), 3, 'no new request after the cancel');
    assert.equal((await s.close()).code, 0);
});

test('server: bad arguments fail at start, and an unknown job is an error', async () => {
    const s = server();
    const bad = await s.tool('start_warriorgpt_job', { prompt: 'x', check: 'npm test' });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /check needs files/);
    const unknown = await s.tool('get_warriorgpt_job_status', { job_id: 'wgpt-00000000' });
    assert.equal(unknown.isError, true);
    assert.match(unknown.text, /No job wgpt-00000000/);
    await s.close();
});

test('server: a job still running when the client goes away is cancelled and its files restored', async () => {
    const { one, args } = setup((one) => [block(one, edit('start', 'bad')), { content: block(one, edit('bad', 'good')), delay_ms: 30_000 }]);
    const s = server();
    await s.tool('start_warriorgpt_job', args);
    for (let i = 0; i < 50 && readFileSync(one, 'utf8') !== 'bad\n'; i++) await pause(50);
    assert.equal(readFileSync(one, 'utf8'), 'bad\n', 'attempt 1 was written');
    const t0 = Date.now();
    const { code } = await s.close();
    assert.equal(code, 0);
    assert.ok(Date.now() - t0 < 10_000);
    assert.equal(readFileSync(one, 'utf8'), 'start\n');
});
