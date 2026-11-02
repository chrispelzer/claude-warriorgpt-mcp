import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeCopy, inside } from '../workspace.mjs';

function tree() {
    const root = mkdtempSync(join(tmpdir(), 'warriorgpt-ws-test-'));
    mkdirSync(join(root, 'src', 'deep'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true });
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.js'), 'export const a = 1;\n');
    writeFileSync(join(root, 'src', 'deep', 'b.txt'), 'b\r\n');
    writeFileSync(join(root, 'node_modules', 'dep', 'index.js'), 'module.exports = 42;\n');
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    return root;
}

test('a copy has every file byte for byte, links node_modules, and leaves out .git', async () => {
    const root = tree();
    const copy = await makeCopy(root);
    assert.ok(!inside(root, copy.dir), 'the copy is not inside the tree');
    assert.equal(readFileSync(join(copy.dir, 'src', 'a.js'), 'utf8'), 'export const a = 1;\n');
    assert.deepEqual(readFileSync(join(copy.dir, 'src', 'deep', 'b.txt')), Buffer.from('b\r\n'));
    assert.equal(readFileSync(join(copy.dir, 'node_modules', 'dep', 'index.js'), 'utf8'), 'module.exports = 42;\n');
    assert.ok(lstatSync(join(copy.dir, 'node_modules')).isSymbolicLink(), 'node_modules is a link, not a copy');
    assert.equal(existsSync(join(copy.dir, '.git')), false);
    assert.equal(copy.to(join(root, 'src', 'a.js')), join(copy.dir, 'src', 'a.js'));
    // Writing in the copy leaves the original alone.
    writeFileSync(copy.to(join(root, 'src', 'a.js')), 'changed');
    assert.equal(readFileSync(join(root, 'src', 'a.js'), 'utf8'), 'export const a = 1;\n');
    await copy.cleanup();
});

test('cleanup removes the copy but never what node_modules links to', async () => {
    const root = tree();
    const copy = await makeCopy(root);
    await copy.cleanup();
    assert.equal(existsSync(copy.dir), false);
    assert.equal(readFileSync(join(root, 'node_modules', 'dep', 'index.js'), 'utf8'), 'module.exports = 42;\n');
});

test('a temp folder inside the tree is not used, and copies being made at the same time never copy each other', async () => {
    const root = tree();
    const inner = join(root, 'tmp');
    mkdirSync(inner);
    mkdirSync(join(root, 'wgpt-attempt-old'));
    writeFileSync(join(root, 'wgpt-attempt-old', 'x.txt'), 'stale copy');
    const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
    Object.assign(process.env, { TMPDIR: inner, TEMP: inner, TMP: inner });
    let copies;
    try {
        assert.equal(tmpdir(), inner);
        copies = await Promise.all([makeCopy(root), makeCopy(root), makeCopy(root)]);
    } finally {
        for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    for (const c of copies) {
        assert.ok(!inside(root, c.dir), `${c.dir} is outside the tree`);
        assert.deepEqual(readdirSync(join(c.dir)).filter((n) => n.startsWith('wgpt-attempt-')), []);
        await c.cleanup();
    }
});
