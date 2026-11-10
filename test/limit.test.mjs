// The request limit shared by every job in a process and, through lock files, by every process on the machine.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createLimiter, STALE_MS } from '../limit.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const SERVER = resolve(here, '../warriorgpt-mcp.mjs');
const MOCK = pathToFileURL(join(here, 'mock-fetch.mjs')).href;
const LIMIT = pathToFileURL(resolve(here, '../limit.mjs')).href;

let dir;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'warriorgpt-limit-test-'));
});

const pause = (ms) => new Promise((done) => setTimeout(done, ms));

// Runs n tasks that each hold a slot for ms, through the given limiters in turn; returns the most held at once.
async function most(limiters, n, ms) {
    let now = 0;
    let top = 0;
    await Promise.all(Array.from({ length: n }, async (_, i) => {
        const release = await limiters[i % limiters.length].acquire();
        top = Math.max(top, ++now);
        await pause(ms);
        now--;
        release();
    }));
    return top;
}

// The most intervals [start, end] that overlap at any moment.
function overlap(spans) {
    const edges = spans.flatMap(([s, e]) => [[s, 1], [e, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let now = 0;
    let top = 0;
    for (const [, d] of edges) top = Math.max(top, (now += d));
    return top;
}

test('in one process: no more than max at once, and a waiter can be cancelled', async () => {
    const limiter = createLimiter({ max: 2 });
    assert.equal(await most([limiter], 6, 30), 2);
    const a = await limiter.acquire();
    const b = await limiter.acquire();
    const ctl = new AbortController();
    const waiting = limiter.acquire(ctl.signal);
    ctl.abort(new Error('gave up'));
    await assert.rejects(waiting, /gave up/);
    a();
    b();
    // The cancelled waiter took no slot with it.
    assert.deepEqual(limiter.stats(), { active: 0, waiting: 0, max: 2, shared: false });
    assert.equal(await most([limiter], 4, 10), 2);
});

test('max 0 turns the limit off', async () => {
    assert.equal(await most([createLimiter({ max: 0 })], 5, 20), 5);
});

test('two limiters on one lock folder share the limit, and leave no slot files behind', async () => {
    const lockDir = join(dir, 'slots');
    const one = createLimiter({ max: 2, dir: lockDir });
    const two = createLimiter({ max: 2, dir: lockDir });
    assert.equal(await most([one, two], 8, 40), 2);
    assert.deepEqual(readdirSync(lockDir), []);
});

test('separate processes share the limit through the lock files', async () => {
    const lockDir = join(dir, 'slots');
    const script = `import { createLimiter } from ${JSON.stringify(LIMIT)};
        import { appendFileSync } from 'node:fs';
        const l = createLimiter({ max: 2, dir: ${JSON.stringify(lockDir)} });
        await Promise.all([0, 1].map(async () => {
            const release = await l.acquire();
            const s = Date.now();
            await new Promise((d) => setTimeout(d, 250));
            appendFileSync(${JSON.stringify(join(dir, 'spans.txt'))}, s + ' ' + Date.now() + '\\n');
            release();
        }));`;
    const run = () => new Promise((done, fail) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
        let err = '';
        child.stderr.on('data', (d) => { err += d; });
        child.on('close', (code) => (code === 0 ? done() : fail(new Error(err))));
    });
    await Promise.all([run(), run(), run()]);
    const spans = readFileSync(join(dir, 'spans.txt'), 'utf8').trim().split('\n').map((l) => l.split(' ').map(Number));
    assert.equal(spans.length, 6);
    assert.ok(overlap(spans) <= 2, `at most 2 at once, saw ${overlap(spans)}`);
    assert.deepEqual(readdirSync(lockDir), []);
});

test('slots left by a dead process or untouched for too long are taken over; a live holder is waited for', async () => {
    const lockDir = join(dir, 'slots');
    mkdirSync(lockDir);
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    writeFileSync(join(lockDir, 'slot-0'), JSON.stringify({ pid: dead, host: hostname(), token: 'x' }));
    writeFileSync(join(lockDir, 'slot-1'), JSON.stringify({ pid: process.pid, host: 'elsewhere', token: 'y' }));
    const old = new Date(Date.now() - STALE_MS - 60_000);
    utimesSync(join(lockDir, 'slot-1'), old, old);
    writeFileSync(join(lockDir, 'slot-2'), JSON.stringify({ pid: process.pid, host: hostname(), token: 'z' }));

    const limiter = createLimiter({ max: 3, dir: lockDir });
    const a = await limiter.acquire();
    const b = await limiter.acquire();
    const ctl = new AbortController();
    const third = limiter.acquire(ctl.signal);
    await pause(400);
    ctl.abort(new Error('still held'));
    await assert.rejects(third, /still held/);
    a();
    b();
    assert.deepEqual(readdirSync(lockDir), ['slot-2']);
});

test('the server keeps its requests within WARRIORGPT_MAX_CONCURRENCY across parallel attempts', () => {
    const one = join(dir, 'one.txt');
    writeFileSync(one, 'start\n');
    writeFileSync(join(dir, 'check.mjs'), "import { readFileSync } from 'node:fs';\n" +
        "if (!readFileSync(new URL('./one.txt', import.meta.url), 'utf8').includes('good')) process.exit(1);\n");
    const reply = { content: `=== FILE: ${one} ===\n<<<<<<< SEARCH\nstart\n=======\ngood\n>>>>>>> REPLACE\n=== END FILE ===`, delay_ms: 250 };
    writeFileSync(join(dir, 'replies.json'), JSON.stringify([reply]));
    const home = join(dir, 'home');
    mkdirSync(home, { recursive: true });
    const peak = (max) => {
        const file = join(dir, `in-flight-${max}.txt`);
        writeFileSync(one, 'start\n');
        const res = spawnSync(process.execPath, ['--import', MOCK, SERVER], {
            input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ask_warriorgpt',
                arguments: { prompt: 'x', files: [one], check: `"${process.execPath}" check.mjs`, cwd: dir, parallel: 4, loop_lane: false } } }) + '\n',
            encoding: 'utf8',
            env: { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: home, WARRIORGPT_API_KEY: 'test-key',
                CLAUDE_CODE_SESSION_ID: 'test', MOCK_REPLIES: join(dir, 'replies.json'), MOCK_STREAM: '1',
                MOCK_IN_FLIGHT: file, WARRIORGPT_MAX_CONCURRENCY: String(max) },
        });
        assert.equal(res.status, 0, res.stderr);
        const out = JSON.parse(res.stdout.trim().split('\n')[0]);
        assert.equal(!!out.result.isError, false, out.result.content[0].text);
        return Number(readFileSync(file, 'utf8'));
    };
    assert.equal(peak(2), 2);
    // The same run without the limit sends all four at once, so the mock does see them overlap.
    assert.equal(peak(6), 4);
});
