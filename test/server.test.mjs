import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
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

function rpc(lines, { reply = '', finish, env = {}, mock = true } = {}) {
    const replyFile = join(dir, 'reply.txt');
    writeFileSync(replyFile, reply);
    const home = join(dir, 'home');
    mkdirSync(home, { recursive: true });
    const res = spawnSync(process.execPath, [...(mock ? ['--import', MOCK] : []), SERVER], {
        input: lines.map((l) => JSON.stringify({ jsonrpc: '2.0', ...l })).join('\n') + '\n',
        encoding: 'utf8',
        // Keep the usage log out of the real home directory.
        env: { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: home, WARRIORGPT_API_KEY: 'test-key',
            CLAUDE_CODE_SESSION_ID: 'test', MOCK_REPLY: replyFile, MOCK_FINISH: finish || '',
            MOCK_REQUEST: join(dir, 'request.json'), ...env },
    });
    assert.equal(res.status, 0, res.stderr);
    return res.stdout.trim().split('\n').map((l) => JSON.parse(l));
}

function call(args, opts) {
    const [res] = rpc([{ id: 1, method: 'tools/call', params: { name: 'ask_warriorgpt', arguments: args } }], opts);
    return { text: res.result.content[0].text, isError: !!res.result.isError };
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

test('plain call returns the reply and logs usage', () => {
    const { text, isError } = call({ prompt: 'hi' }, { reply: 'hello' });
    assert.equal(isError, false);
    assert.match(text, /^hello\n\n\(local\.qwen3\.8-27b, 10 in \/ 20 out tokens\)$/);
    const stateDir = process.platform === 'win32' ? join(dir, 'home', 'warriorgpt-mcp')
        : join(dir, 'home', '.local', 'share', 'warriorgpt-mcp');
    const log = JSON.parse(readFileSync(join(stateDir, 'usage.jsonl'), 'utf8'));
    assert.deepEqual({ session: log.session, in: log.in, out: log.out }, { session: 'test', in: 10, out: 20 });
});

test('output_file writes the unfenced reply', () => {
    const out = join(dir, 'out', 'a.txt');
    const { text } = call({ prompt: 'x', output_file: out }, { reply: '```js\nconst a = 1;\n```' });
    assert.match(text, /^Wrote 1 lines to /);
    assert.equal(readFileSync(out, 'utf8'), 'const a = 1;\n');
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
