// Requests the gateway turned away (429), connections that dropped, and streams it marks as cut short are sent again.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { backoffMs, errorBody, isTransientNetworkError, rateLimitWait, retryAfterMs, serverWaitMs, statusRetry } from '../retry.mjs';
import { readStream, uniqueIds } from '../ask.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const SERVER = resolve(here, '../warriorgpt-mcp.mjs');
const MOCK = pathToFileURL(join(here, 'mock-fetch.mjs')).href;

let dir;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'warriorgpt-retry-test-'));
});

function call(args, { reply = 'hello', env = {} } = {}) {
    writeFileSync(join(dir, 'reply.txt'), reply);
    const home = join(dir, 'home');
    mkdirSync(home, { recursive: true });
    const res = spawnSync(process.execPath, ['--import', MOCK, SERVER], {
        input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ask_warriorgpt', arguments: args } }) + '\n',
        encoding: 'utf8',
        env: { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: home, WARRIORGPT_API_KEY: 'test-key',
            CLAUDE_CODE_SESSION_ID: 'test', MOCK_REPLY: join(dir, 'reply.txt'), MOCK_TIMES: join(dir, 'times.txt'),
            WARRIORGPT_RETRY_BASE_MS: '1', ...env },
    });
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout.trim().split('\n')[0]);
    return { text: out.result.content[0].text, isError: !!out.result.isError, stderr: res.stderr };
}
const times = () => readFileSync(join(dir, 'times.txt'), 'utf8').trim().split('\n').map(Number);

test('Retry-After is read as seconds (fractions too) or an HTTP date', () => {
    assert.equal(retryAfterMs('5'), 5000);
    assert.equal(retryAfterMs('0.25'), 250);
    assert.equal(retryAfterMs(new Date(10_000).toUTCString(), 4000), 6000);
    assert.equal(retryAfterMs(null), null);
    assert.equal(retryAfterMs('soon'), null);
});

test('backoff doubles from the base, with jitter in the upper half, capped at 30 s', () => {
    assert.equal(backoffMs(1, 1000, () => 0), 500);
    assert.equal(backoffMs(1, 1000, () => 1), 1000);
    assert.equal(backoffMs(3, 1000, () => 1), 4000);
    assert.equal(backoffMs(20, 1000, () => 1), 30000);
});

test('a busy-key 429 is waited out; a quota 429 or a wait of minutes is not', () => {
    assert.equal(rateLimitWait('concurrency_limit_exceeded', 5000), 5000);
    assert.equal(rateLimitWait('rate_limit_exceeded', null), 0);
    assert.equal(rateLimitWait('quota_exceeded', 1000), null);
    assert.equal(rateLimitWait('rate_limit_exceeded', 3_600_000), null);
    assert.deepEqual(errorBody('{"error":{"message":"busy","code":"x"}}'), { message: 'busy', code: 'x' });
    assert.deepEqual(errorBody('<html>'), { message: '<html>', code: '' });
});

test('transient network failures are told apart from certificate errors and aborts', () => {
    assert.equal(isTransientNetworkError(new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ECONNRESET' }) })), true);
    assert.equal(isTransientNetworkError(new Error('socket hang up')), true);
    assert.equal(isTransientNetworkError(new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'CERT_HAS_EXPIRED' }) })), false);
    assert.equal(isTransientNetworkError(Object.assign(new Error('aborted'), { name: 'AbortError' })), false);
    assert.equal(isTransientNetworkError(new Error('Unexpected token')), false);
});

test('a 429 is retried after the Retry-After the server sent, and logged', () => {
    const log = join(dir, 'run.log');
    const { text, isError, stderr } = call({ prompt: 'hi', log_file: log },
        { env: { MOCK_FAIL_FIRST: JSON.stringify(['429', '429']), MOCK_RETRY_AFTER: '0.3' } });
    assert.equal(isError, false, text);
    assert.match(text, /^hello/);
    const t = times();
    assert.equal(t.length, 3);
    // The backoff base is 1 ms here, so only Retry-After can account for the gaps.
    assert.ok(t[1] - t[0] >= 280 && t[2] - t[1] >= 280, `gaps ${t[1] - t[0]}, ${t[2] - t[1]}`);
    const logged = readFileSync(log, 'utf8');
    assert.match(logged, /WarriorGPT: 429 concurrency_limit_exceeded: Too many concurrent requests .*; retry 1 of 5 in 0\.3 s/);
    assert.match(logged, /retry 2 of 5/);
    assert.match(stderr, /retry 1 of 5/);
});

test('retries are bounded, and the final error carries the server message and the limit', () => {
    const { text, isError } = call({ prompt: 'hi' },
        { env: { MOCK_FAIL_FIRST: JSON.stringify(Array(10).fill('429')), MOCK_RETRY_AFTER: '0.01', WARRIORGPT_MAX_RETRIES: '2' } });
    assert.equal(isError, true);
    assert.match(text, /WarriorGPT 429 \(concurrency_limit_exceeded\): Too many concurrent requests for this API key \(limit 6\)/);
    assert.match(text, /gave up after 3 tries/);
    assert.equal(times().length, 3);
});

test('a quota 429 fails at once with its message', () => {
    const { text, isError } = call({ prompt: 'hi' }, { env: { MOCK_FAIL_FIRST: JSON.stringify(['quota']) } });
    assert.equal(isError, true);
    assert.match(text, /429 \(quota_exceeded\): You exceeded your current quota/);
    assert.equal(times().length, 1);
});

test('a connection reset before any reply is retried', () => {
    const { text, isError } = call({ prompt: 'hi' }, { env: { MOCK_FAIL_FIRST: JSON.stringify(['reset', 'reset']) } });
    assert.equal(isError, false, text);
    assert.match(text, /^hello/);
    assert.equal(times().length, 3);
});

test('a stream the gateway marks incomplete is retried, not taken as the answer', () => {
    const out = join(dir, 'out.txt');
    const { text, isError } = call({ prompt: 'hi', output_file: out },
        { reply: 'the whole reply', env: { MOCK_STREAM: '1', MOCK_FAIL_FIRST: JSON.stringify(['incomplete']) } });
    assert.equal(isError, false, text);
    assert.equal(readFileSync(out, 'utf8'), 'the whole reply\n');
    assert.equal(times().length, 2);
});

test('a stream that keeps getting cut off ends in an error, and nothing is written', () => {
    const out = join(dir, 'out.txt');
    const { text, isError } = call({ prompt: 'hi', output_file: out },
        { env: { MOCK_STREAM: '1', MOCK_FAIL_FIRST: JSON.stringify(Array(5).fill('incomplete')), WARRIORGPT_MAX_RETRIES: '1' } });
    assert.equal(isError, true);
    assert.match(text, /upstream_stream_incomplete/);
    assert.match(text, /gave up after 2 tries/);
    assert.equal(existsSync(out), false);
});

const headers = (h) => (name) => h[name] ?? null;

test('gateway 5xx: 502/503 retried like a busy key, 504 as a timeout, 500 as a server error; x-should-retry overrides', () => {
    assert.deepEqual(statusRetry(502, 'upstream_unreachable', headers({})), { kind: 'busy', waitMs: 0 });
    assert.deepEqual(statusRetry(503, '', headers({ 'retry-after': '2' })), { kind: 'busy', waitMs: 2000 });
    assert.deepEqual(statusRetry(504, 'upstream_timeout', headers({})), { kind: 'timeout', waitMs: 0 });
    assert.deepEqual(statusRetry(500, 'internal_error', headers({})), { kind: 'server', waitMs: 0 });
    assert.equal(statusRetry(400, '', headers({})), null);
    assert.equal(statusRetry(401, '', headers({})), null);
    assert.equal(statusRetry(502, '', headers({ 'x-should-retry': 'false' })), null);
    assert.deepEqual(statusRetry(400, '', headers({ 'x-should-retry': 'true' })), { kind: 'busy', waitMs: 0 });
    assert.equal(statusRetry(429, 'quota_exceeded', headers({})), null);
});

test('retry-after-ms wins over Retry-After', () => {
    assert.equal(serverWaitMs(headers({ 'retry-after-ms': '250', 'retry-after': '9' })), 250);
    assert.equal(serverWaitMs(headers({ 'retry-after': '1.5' })), 1500);
    assert.equal(serverWaitMs(headers({})), null);
});

const sse = (...events) => [new TextEncoder().encode(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n')];
const delta = (d, finish) => ({ choices: [{ delta: d, ...(finish ? { finish_reason: finish } : {}) }] });

test('tool-call deltas: matched by id, sparse pieces go to the latest call, the first name sticks', async () => {
    const reply = await readStream(sse(
        delta({ tool_calls: [{ id: 'a', function: { name: 'read_file', arguments: '' } }] }),
        delta({ tool_calls: [{ function: { name: 'read_file', arguments: '{"path":' } }] }),
        delta({ tool_calls: [{ function: { arguments: '"x"}' } }] }),
        delta({ tool_calls: [{ id: 'b', function: { name: 'edit', arguments: '{}' } }] }),
        delta({ tool_calls: [{ id: 'a', function: { arguments: '' } }] }),
        delta({}, 'tool_calls')));
    assert.deepEqual(reply.choices[0].message.tool_calls.map((c) => [c.id, c.function.name, c.function.arguments]),
        [['a', 'read_file', '{"path":"x"}'], ['b', 'edit', '{}']]);
    assert.deepEqual(uniqueIds(['x', '', 'x', 'call_1']), ['x', 'call_1', 'call_2', 'call_3']);
});

test('a finish reason other than stop, length or tool_calls is a cut stream', async () => {
    await assert.rejects(readStream(sse(delta({ content: 'part' }, 'content_filter'))),
        (err) => /finish_reason content_filter/.test(err.message) && !!err.retry);
    const ok = await readStream(sse(delta({ content: 'all' }, 'length')));
    assert.equal(ok.choices[0].finish_reason, 'length');
});

test('gateway 502 and 503 are retried, honouring retry-after-ms as the least wait', () => {
    const { text, isError } = call({ prompt: 'hi' }, { env: { MOCK_FAIL_FIRST: JSON.stringify(['502',
        { status: 503, code: 'upstream_unavailable', headers: { 'retry-after-ms': 300 } }]) } });
    assert.equal(isError, false, text);
    const t = times();
    assert.equal(t.length, 3);
    assert.ok(t[2] - t[1] >= 280, `gap ${t[2] - t[1]}`);
});

test('504 is retried at most twice and 500 once; x-should-retry: false is not retried', () => {
    let r = call({ prompt: 'hi' }, { env: { MOCK_FAIL_FIRST: JSON.stringify(Array(5).fill('504')) } });
    assert.equal(r.isError, true);
    assert.match(r.text, /WarriorGPT 504 \(upstream_timeout\): .*Retry the request.*gave up after 3 tries/);
    assert.equal(times().length, 3);
    dir = mkdtempSync(join(tmpdir(), 'warriorgpt-retry-test-'));
    r = call({ prompt: 'hi' }, { env: { MOCK_FAIL_FIRST: JSON.stringify(Array(5).fill('500')) } });
    assert.match(r.text, /WarriorGPT 500 \(internal_error\).*gave up after 2 tries/);
    assert.equal(times().length, 2);
    dir = mkdtempSync(join(tmpdir(), 'warriorgpt-retry-test-'));
    r = call({ prompt: 'hi' }, { env: { MOCK_FAIL_FIRST: JSON.stringify([{ status: 502, headers: { 'x-should-retry': 'false' } }]) } });
    assert.equal(r.isError, true);
    assert.equal(times().length, 1);
});

test('a connection reset mid-stream is retried from the start', () => {
    const { text, isError } = call({ prompt: 'hi' }, { reply: 'the whole reply',
        env: { MOCK_STREAM: '1', MOCK_FAIL_FIRST: JSON.stringify(['reset-mid']) } });
    assert.equal(isError, false, text);
    assert.match(text, /^the whole reply\n/);
    assert.equal(times().length, 2);
});

test('no headers within the header timeout, or a stream gone quiet past the idle timeout, is retried', () => {
    const env = { MOCK_STREAM: '1', WARRIORGPT_HEADER_TIMEOUT_MS: '200', WARRIORGPT_IDLE_TIMEOUT_MS: '200' };
    const log = join(dir, 'run.log');
    const { text, isError } = call({ prompt: 'hi', log_file: log }, { env: { ...env, MOCK_FAIL_FIRST: JSON.stringify(['hang', 'stall']) } });
    assert.equal(isError, false, text);
    assert.match(text, /^hello/);
    assert.equal(times().length, 3);
    const logged = readFileSync(log, 'utf8');
    assert.match(logged, /no response within 0\.2 s; retry 1 of 5/);
    assert.match(logged, /the stream stalled \(no data for 0\.2 s\); retry 2 of 5/);
});

test('timeouts share the 504 cap of two retries', () => {
    const { text, isError } = call({ prompt: 'hi' }, { env: { MOCK_STREAM: '1', WARRIORGPT_IDLE_TIMEOUT_MS: '100',
        MOCK_FAIL_FIRST: JSON.stringify(Array(5).fill('stall')) } });
    assert.equal(isError, true);
    assert.match(text, /no data for 0\.1 s.*gave up after 3 tries/);
    assert.equal(times().length, 3);
});
