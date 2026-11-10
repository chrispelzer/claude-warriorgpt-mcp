import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const SERVER = resolve(here, '../warriorgpt-mcp.mjs');
const MOCK = pathToFileURL(join(here, 'mock-fetch.mjs')).href;

let dir;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'warriorgpt-mcp-test-'));
});

function rpc(lines, { reply = '', replies, finish, env = {}, mock = true } = {}) {
    const replyFile = join(dir, 'reply.txt');
    writeFileSync(replyFile, reply);
    if (replies) {
        writeFileSync(join(dir, 'replies.json'), JSON.stringify(replies));
        env = { MOCK_REPLIES: join(dir, 'replies.json'), MOCK_REQUEST_LOG: join(dir, 'requests.jsonl'), ...env };
    }
    const home = join(dir, 'home');
    mkdirSync(home, { recursive: true });
    const res = spawnSync(process.execPath, [...(mock ? ['--import', MOCK] : []), SERVER], {
        input: lines.map((l) => JSON.stringify({ jsonrpc: '2.0', ...l })).join('\n') + '\n',
        encoding: 'utf8',
        // Keep the usage log out of the real home directory.
        env: { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: home, WARRIORGPT_API_KEY: 'test-key',
            CLAUDE_CODE_SESSION_ID: 'test', MOCK_REPLY: replyFile, MOCK_FINISH: finish || '',
            MOCK_REQUEST: join(dir, 'request.json'), WARRIORGPT_RETRY_BASE_MS: '1', ...env },
    });
    assert.equal(res.status, 0, res.stderr);
    return res.stdout.trim().split('\n').map((l) => JSON.parse(l));
}

function call(args, opts) {
    const [res] = rpc([{ id: 1, method: 'tools/call', params: { name: 'ask_warriorgpt', arguments: { parallel: 1, loop_lane: false, ...args } } }], opts);
    return { text: res.result.content[0].text, isError: !!res.result.isError, structured: res.result.structuredContent };
}

const block = (path, body) => `=== FILE: ${path} ===\n${body}\n=== END FILE ===`;
const edit = (search, replace) => `<<<<<<< SEARCH\n${search}\n=======\n${replace ? replace + '\n' : ''}>>>>>>> REPLACE`;

test('initialize and tools/list describe the tool', () => {
    const [init, list] = rpc([
        { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
        { id: 2, method: 'tools/list' },
    ]);
    assert.equal(init.result.protocolVersion, '2025-06-18');
    const tool = list.result.tools[0];
    assert.equal(tool.name, 'ask_warriorgpt');
    assert.ok(tool.inputSchema.properties.files);
});

test('the schema lists loop_lane and the new parallel default', () => {
    const [list] = rpc([{ id: 1, method: 'tools/list' }]);
    const props = list.result.tools[0].inputSchema.properties;
    assert.equal(props.loop_lane.type, 'boolean');
    assert.match(props.loop_lane.description, /default true/);
    assert.match(props.parallel.description, /default 1/);
});

test('plain call returns the reply and logs usage', () => {
    const { text, isError } = call({ prompt: 'hi' }, { reply: 'hello' });
    assert.equal(isError, false);
    assert.match(text, /^hello\n\n\(local\.qwen3\.8-27b, 10 in \/ 20 out tokens\)$/);
    const stateDir = process.platform === 'win32' ? join(dir, 'home', 'warriorgpt-mcp')
        : join(dir, 'home', '.local', 'share', 'warriorgpt-mcp');
    const log = JSON.parse(readFileSync(join(stateDir, 'usage.jsonl'), 'utf8'));
    assert.deepEqual({ session: log.session, in: log.in, out: log.out }, { session: 'test', in: 10, out: 20 });
});

test('a streamed reply is reassembled, with usage and the request asking for a stream', () => {
    const { text, isError } = call({ prompt: 'hi' }, { reply: 'hello there, streamed', env: { MOCK_STREAM: '1' } });
    assert.equal(isError, false);
    assert.match(text, /^hello there, streamed\n\n\(local\.qwen3\.8-27b, 10 in \/ 20 out tokens\)$/);
    const body = JSON.parse(readFileSync(join(dir, 'request.json'), 'utf8'));
    assert.equal(body.stream, true);
    assert.deepEqual(body.stream_options, { include_usage: true });
});

test('a streamed reply cut off at max_tokens is still reported', () => {
    const { text, isError } = call({ prompt: 'hi', output_file: join(dir, 'out', 'cut.txt') },
        { reply: 'partial', finish: 'length', env: { MOCK_STREAM: '1' } });
    assert.equal(isError, true);
    assert.match(text, /max_tokens|cut off/i);
});

test('a streamed reply that ends without a finish reason is an error, and output_file is not written', () => {
    const out = join(dir, 'out', 'partial.txt');
    const { text, isError } = call({ prompt: 'hi', output_file: out },
        { reply: 'half a reply', env: { MOCK_STREAM: '1', MOCK_NO_FINISH: '1' } });
    assert.equal(isError, true);
    assert.match(text, /broke off: the stream ended before the reply finished/);
    assert.equal(existsSync(out), false);
});

test('output_file writes the unfenced reply', () => {
    const out = join(dir, 'out', 'a.txt');
    const { text } = call({ prompt: 'x', output_file: out }, { reply: '```js\nconst a = 1;\n```' });
    assert.match(text, /^Wrote 1 lines to /);
    assert.equal(readFileSync(out, 'utf8'), 'const a = 1;\n');
});

test('an empty reply leaves output_file untouched', () => {
    const out = join(dir, 'keep.txt');
    writeFileSync(out, 'precious\n');
    const { text, isError } = call({ prompt: 'x', output_file: out }, { reply: '   \n' });
    assert.equal(isError, true);
    assert.match(text, /Reply was empty/);
    assert.equal(readFileSync(out, 'utf8'), 'precious\n');
});

test('files: edits, deletes, keeps CRLF, creates new and nested files', () => {
    const one = join(dir, 'one.txt');
    const crlf = join(dir, 'crlf.txt');
    const created = join(dir, 'new.txt');
    const nested = join(dir, 'sub', 'deep.txt');
    writeFileSync(one, 'a\nb\nc\nb\n');
    writeFileSync(crlf, 'x\r\ny\r\n');
    const reply = [
        block(one, `${edit('a', 'A')}\n${edit('c', '')}`),
        block('crlf.txt', edit('y', 'Y')),
        block(created, '```\nhello\n```'),
        block(nested, 'deep'),
    ].join('\n');
    const { text, isError } = call({ prompt: 'x', files: [one, crlf, created, nested] }, { reply });
    assert.equal(isError, false, text);
    assert.equal(readFileSync(one, 'utf8'), 'A\nb\nb\n');
    assert.equal(readFileSync(crlf, 'utf8'), 'x\r\nY\r\n');
    assert.equal(readFileSync(created, 'utf8'), 'hello\n');
    assert.equal(readFileSync(nested, 'utf8'), 'deep\n');
    assert.match(text, /edited .*one\.txt \(2 edits\)/);
    assert.match(text, /created .*new\.txt \(1 lines\)/);
});

test('files: attaches existing files and lists new ones in the prompt', () => {
    const existing = join(dir, 'existing.txt');
    const fresh = join(dir, 'fresh.txt');
    writeFileSync(existing, 'original contents');
    call({ prompt: 'x', files: [existing, fresh] }, { reply: block(fresh, 'hi') });
    const body = JSON.parse(readFileSync(join(dir, 'request.json'), 'utf8'));
    const user = body.messages.find((m) => m.role === 'user').content;
    assert.ok(user.includes('original contents'));
    assert.ok(user.includes(`- ${fresh} (new)`));
    assert.match(body.messages.find((m) => m.role === 'system').content, /=== FILE:/);
});

test('files: unchanged files are reported', () => {
    const a = join(dir, 'a.txt');
    const b = join(dir, 'b.txt');
    writeFileSync(a, '1\n');
    writeFileSync(b, '2\n');
    const { text } = call({ prompt: 'x', files: [a, b] }, { reply: block(a, edit('1', 'one')) });
    assert.match(text, /unchanged: .*b\.txt/);
});

test('files: an ambiguous search writes nothing, not even other valid files', () => {
    const one = join(dir, 'one.txt');
    const created = join(dir, 'new.txt');
    writeFileSync(one, 'b\nb\n');
    const reply = [block(created, 'hi'), block(one, edit('b', 'B'))].join('\n');
    const { text, isError } = call({ prompt: 'x', files: [one, created] }, { reply });
    assert.equal(isError, true);
    assert.match(text, /matches 2 places/);
    assert.equal(existsSync(created), false);
    assert.equal(readFileSync(one, 'utf8'), 'b\nb\n');
});

test('files: lists every problem and writes nothing', () => {
    const one = join(dir, 'one.txt');
    const missing = join(dir, 'missing.txt');
    writeFileSync(one, 'a\n');
    const reply = [
        block(resolve('/elsewhere/evil.txt'), 'pwn'),
        block(missing, edit('z', 'Z')),
        block(one, edit('nope', 'x')),
    ].join('\n');
    const { text, isError } = call({ prompt: 'x', files: [one, missing] }, { reply });
    assert.equal(isError, true);
    assert.match(text, /evil\.txt: not in files/);
    assert.match(text, /edit blocks for a file that does not exist/);
    assert.match(text, /search text not found/);
    assert.equal(readFileSync(one, 'utf8'), 'a\n');
});

test('files: prose around blocks and a missing last end marker are tolerated', () => {
    const one = join(dir, 'one.txt');
    const two = join(dir, 'two.txt');
    writeFileSync(one, 'a\n');
    writeFileSync(two, '    x = 1;   \n');
    const reply = `Here is the fix:\n${block(one, edit('a', 'A'))}\nAnd then:\n=== FILE: ${two} ===\n${edit('x = 1;', 'x = 2;')}\n`;
    const { text, isError } = call({ prompt: 'x', files: [one, two] }, { reply });
    assert.equal(isError, false, text);
    assert.equal(readFileSync(one, 'utf8'), 'A\n');
    assert.equal(readFileSync(two, 'utf8'), '    x = 2;   \n');
});

test('files: a loosely matched search is applied and reported', () => {
    const one = join(dir, 'one.txt');
    writeFileSync(one, 'if (a) {\n    go();\n}\n');
    const { text, isError } = call({ prompt: 'x', files: [one] }, { reply: block(one, edit('if (a) {\ngo();\n}', 'if (a) {\nstop();\n}')) });
    assert.equal(isError, false, text);
    assert.match(text, /1 matched loosely: line-trimmed/);
    assert.equal(readFileSync(one, 'utf8'), 'if (a) {\nstop();\n}\n');
});

test('files: a reply without file blocks is an error', () => {
    const { text, isError } = call({ prompt: 'x', files: [join(dir, 'a.txt')] }, { reply: 'Sure! Here is the code.' });
    assert.equal(isError, true);
    assert.match(text, /no file blocks/);
});

test('a reply cut off at max_tokens writes nothing', () => {
    const one = join(dir, 'one.txt');
    writeFileSync(one, 'a\n');
    const { text, isError } = call({ prompt: 'x', files: [one] }, { reply: block(one, edit('a', 'A')), finish: 'length' });
    assert.equal(isError, true);
    assert.match(text, /cut off at max_tokens/);
    assert.equal(readFileSync(one, 'utf8'), 'a\n');
});

test('files and output_file together are rejected', () => {
    const { text, isError } = call({ prompt: 'x', files: [join(dir, 'a')], output_file: join(dir, 'b') });
    assert.equal(isError, true);
    assert.match(text, /not both/);
});

test('a missing API key is reported without calling the API', () => {
    const { text, isError } = call({ prompt: 'x' }, { mock: false, env: { WARRIORGPT_API_KEY: '', USER: 'nobody-test' } });
    assert.equal(isError, true);
    assert.match(text, /^No WarriorGPT API key: set WARRIORGPT_API_KEY/);
});

// A check script that passes only when one.txt says "good".
function goodCheck() {
    writeFileSync(join(dir, 'check.mjs'), "import { readFileSync } from 'node:fs';\n" +
        "const t = readFileSync(new URL('./one.txt', import.meta.url), 'utf8');\n" +
        "if (!t.includes('good')) { console.log('one.txt is NOT GOOD: ' + t.trim()); process.exit(1); }\n");
    return `"${process.execPath}" check.mjs`;
}
const requests = () => readFileSync(join(dir, 'requests.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('check: passes on the first attempt and reports the line counts', () => {
    const one = join(dir, 'one.txt');
    writeFileSync(one, 'start\nkeep\n');
    const { text, isError } = call({ prompt: 'x', files: [one], check: goodCheck(), loop_lane: false },
        { replies: [block(one, edit('start', 'good'))] });
    assert.equal(isError, false, text);
    assert.match(text, /^check passed on parallel attempt 1 of 1/);
    assert.match(text, /\+1 -1 lines across 1 file/);
    assert.equal(readFileSync(one, 'utf8'), 'good\nkeep\n');
    assert.equal(requests().length, 1);
});

test('check: a failing attempt is retried against the current files with the output', () => {
    const one = join(dir, 'one.txt');
    writeFileSync(one, 'start\n');
    const { text, isError } = call({ prompt: 'x', files: [one], check: goodCheck(), loop: false },
        { replies: [block(one, edit('start', 'bad')), block(one, edit('bad', 'good'))] });
    assert.equal(isError, false, text);
    assert.match(text, /^check passed on attempt 2 of 3/);
    assert.match(text, /2 requests, 20 in \/ 40 out tokens/);
    assert.equal(readFileSync(one, 'utf8'), 'good\n');
    const second = requests()[1].messages;
    assert.equal(second.at(-2).role, 'assistant');
    assert.match(second.at(-1).content, /one\.txt is NOT GOOD: bad/);
    assert.match(second.at(-1).content, /earlier edits are still in place/);
    assert.match(second.at(-1).content, /one\.txt\n```\nbad\n\n?```/, 'the retry shows the file as it is now');
    assert.match(text, /\+1 -1 lines/, 'line counts are against the originals');
});

test('check: retries raise the temperature by the step, capped at 0.8', () => {
    const one = join(dir, 'one.txt');
    writeFileSync(one, 'start\n');
    const bad = (from, to) => block(one, edit(from, to));
    call({ prompt: 'x', files: [one], check: goodCheck(), loop: false, max_attempts: 3 },
        { replies: [bad('start', 'a'), bad('a', 'b'), bad('b', 'c')] });
    assert.deepEqual(requests().map((r) => r.temperature), [0.6, 0.7, 0.8]);

    writeFileSync(one, 'start\n');
    rmSync(join(dir, 'requests.jsonl'), { force: true });
    call({ prompt: 'x', files: [one], check: goodCheck(), loop: false, max_attempts: 3, temperature: 0.2, retry_temperature_step: 0.5 },
        { replies: [bad('start', 'a'), bad('a', 'b'), bad('b', 'c')] });
    assert.deepEqual(requests().map((r) => r.temperature), [0.2, 0.7, 0.8]);

    writeFileSync(one, 'start\n');
    rmSync(join(dir, 'requests.jsonl'), { force: true });
    call({ prompt: 'x', files: [one], check: goodCheck(), loop: false, max_attempts: 2, retry_temperature_step: 0 },
        { replies: [bad('start', 'a'), bad('a', 'b')] });
    assert.deepEqual(requests().map((r) => r.temperature), [0.6, 0.6]);
});

test('Qwen models get Qwen thinking-mode sampling; other models keep the server defaults', () => {
    call({ prompt: 'x' }, { replies: ['hi'] });
    const [qwen] = requests();
    assert.deepEqual([qwen.temperature, qwen.top_p, qwen.top_k, qwen.min_p, qwen.presence_penalty], [0.6, 0.95, 20, 0, 1]);
    rmSync(join(dir, 'requests.jsonl'), { force: true });
    call({ prompt: 'x', model: 'local.gpt-oss-120b' }, { replies: ['hi'] });
    const [oss] = requests();
    assert.deepEqual([oss.temperature, oss.top_p, oss.top_k, oss.presence_penalty], [undefined, undefined, undefined, undefined]);
});

test('runaway thinking is retried with an order to stop thinking, without using an attempt', () => {
    const one = join(dir, 'one.txt');
    writeFileSync(one, 'start\n');
    const { text, isError } = call({ prompt: 'x', files: [one], check: goodCheck(), loop: false, max_attempts: 1 },
        { replies: ['', block(one, edit('start', 'good'))], env: { MOCK_FINISH_LIST: JSON.stringify(['length', 'stop']) } });
    assert.equal(isError, false, text);
    assert.match(text, /check passed on attempt 1 of 1/);
    assert.match(text, /2 requests/);
    const second = requests()[1].messages;
    assert.equal(second.at(-1).role, 'user');
    assert.match(second.at(-1).content, /Stop thinking now/);
    assert.doesNotMatch(second.at(-1).content, /smaller edit blocks/);
});

test('free retries for runaway thinking are capped', () => {
    const one = join(dir, 'one.txt');
    writeFileSync(one, 'start\n');
    const { text, isError } = call({ prompt: 'x', files: [one], check: goodCheck(), loop: false, max_attempts: 1 },
        { replies: [''], finish: 'length' });
    assert.equal(isError, true);
    assert.match(text, /check did not pass in 1 attempt/);
    assert.equal(requests().length, 3, 'one attempt plus two free retries');
});

test('a reply cut off mid-edit asks for shorter edits', () => {
    const one = join(dir, 'one.txt');
    writeFileSync(one, 'start\n');
    call({ prompt: 'x', files: [one], check: goodCheck(), loop: false, max_attempts: 2 },
        { replies: [block(one, edit('start', 'goo')), block(one, edit('start', 'good'))],
            env: { MOCK_FINISH_LIST: JSON.stringify(['length', 'stop']) } });
    const second = requests()[1].messages;
    assert.match(second.at(-1).content, /cut off at the output limit \(20 tokens\)[\s\S]*fewer, shorter edit blocks/);
});

test('check: retries keep only the latest reply in the history', () => {
    const one = join(dir, 'one.txt');
    writeFileSync(one, 'start\n');
    const { isError } = call({ prompt: 'x', files: [one], check: goodCheck(), loop: false },
        { replies: [block(one, edit('start', 'bad')), block(one, edit('bad', 'worse')), block(one, edit('worse', 'good'))] });
    assert.equal(isError, false);
    const [first, , third] = requests().map((r) => r.messages);
    assert.equal(third.length, first.length + 2);
    assert.match(third.at(-2).content, /SEARCH\nbad\n=======\nworse/);
    assert.match(third.at(-1).content, /```\nworse\n\n?```/);
});

test('check: a reply that cannot be applied counts as an attempt', () => {
    const one = join(dir, 'one.txt');
    writeFileSync(one, 'start\n');
    const { text, isError } = call({ prompt: 'x', files: [one], check: goodCheck(), loop: false },
        { replies: [block(one, edit('nope', 'good')), block(one, edit('start', 'good'))] });
    assert.equal(isError, false, text);
    assert.match(text, /attempt 2 of 3/);
    assert.match(requests()[1].messages.at(-1).content, /could not be applied:[\s\S]*search text not found/);
});

test('check: when no attempt passes every file is restored byte for byte', () => {
    const one = join(dir, 'one.txt');
    const crlf = join(dir, 'crlf.txt');
    const created = join(dir, 'sub', 'new.txt');
    writeFileSync(one, 'start\n');
    writeFileSync(crlf, 'x\r\ny\r\n');
    const bad = [block(one, edit('start', 'bad')), block(crlf, edit('y', 'Y')), block(created, 'hello')].join('\n');
    const worse = [block(one, edit('bad', 'worse')), block(crlf, edit('Y', 'Z')), block(created, 'hello again')].join('\n');
    const { text, isError } = call({ prompt: 'x', files: [one, crlf, created], check: goodCheck(), loop: false, max_attempts: 2 },
        { replies: [bad, worse] });
    assert.equal(isError, true);
    assert.match(text, /^check did not pass in 2 attempts; every file is back as it was/);
    assert.match(text, /NOT GOOD: worse/, 'the second attempt built on the first');
    assert.match(text, /fallback: opencode/);
    assert.equal(readFileSync(one, 'utf8'), 'start\n');
    assert.deepEqual(readFileSync(crlf), Buffer.from('x\r\ny\r\n'));
    assert.equal(existsSync(created), false);
    assert.equal(requests().length, 2);
});

test('check: a run that never passes carries structured fallback data; other errors do not', () => {
    const one = join(dir, 'one.txt');
    writeFileSync(one, 'start\n');
    const failed = call({ prompt: 'x', files: [one], check: goodCheck(), loop: false, max_attempts: 1 }, { replies: [block(one, edit('start', 'bad'))] });
    assert.deepEqual(failed.structured, { ok: false, fallback: 'opencode', attempts: 1 });
    const unapplied = call({ prompt: 'x', files: [one] }, { replies: [block(one, edit('missing', 'bad'))] });
    assert.equal(unapplied.isError, true);
    assert.equal(unapplied.structured, undefined);
});

test('check: a run past check_timeout_s is killed and counts as a failure', () => {
    const one = join(dir, 'one.txt');
    writeFileSync(one, 'start\n');
    const check = `"${process.execPath}" -e "setTimeout(() => {}, 20000)"`;
    const started = Date.now();
    const { text, isError } = call({ prompt: 'x', files: [one], check, loop: false, max_attempts: 1, check_timeout_s: 1 },
        { replies: [block(one, edit('start', 'good'))] });
    assert.equal(isError, true);
    assert.match(text, /timed out after 1s/);
    assert.equal(readFileSync(one, 'utf8'), 'start\n');
    assert.ok(Date.now() - started < 15000, 'the check was not killed');
});

test('check without files is rejected', () => {
    const { text, isError } = call({ prompt: 'x', check: 'npm test' });
    assert.equal(isError, true);
    assert.match(text, /check needs files/);
});
