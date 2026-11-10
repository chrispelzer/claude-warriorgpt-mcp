// run_node snippets run under Node's permission model: inside the working directory only, no processes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, realpathSync, symlinkSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runNodeArgs, PERMISSION_FLAG } from '../ask.mjs';

function snippet(cwd, code, readOnly) {
    const r = spawnSync(process.execPath, runNodeArgs(cwd, readOnly), { cwd, input: code, encoding: 'utf8' });
    return (r.stdout + r.stderr).trim();
}

test('run_node args: permission flag, reads in the tree and readOnly dirs, no writes at all', () => {
    const args = runNodeArgs('/w/copy', ['/w/orig']);
    assert.equal(args[0], PERMISSION_FLAG);
    assert.ok(args.includes('--allow-fs-read=/w/copy') && args.includes('--allow-fs-read=/w/orig'));
    assert.deepEqual(args.filter((a) => a.startsWith('--allow-fs-write')), []);
    assert.ok(!args.some((a) => /allow-(child-process|worker|addons)/.test(a)));
});

test('run_node args: a linked tree is allowed by its real path too (macOS /var -> /private/var)', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'wgpt-link-')));
    const real = join(root, 'real');
    const link = join(root, 'link');
    mkdirSync(real);
    symlinkSync(real, link, 'junction');
    try {
        const args = runNodeArgs(link);
        assert.ok(args.includes(`--allow-fs-read=${link}`) && args.includes(`--allow-fs-read=${real}`));
        assert.deepEqual(args.filter((a) => a.startsWith('--allow-fs-write')), []);
        writeFileSync(join(real, 'one.txt'), 'hello\n');
        assert.match(snippet(link, "import { readFileSync } from 'node:fs'; console.log(readFileSync('./one.txt', 'utf8'));"), /hello/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('a snippet can import and read in its tree, but cannot write anywhere, spawn, or touch the tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'wgpt-sandbox-'));
    const tree = join(root, 'tree');
    mkdirSync(join(tree, 'src'), { recursive: true });
    writeFileSync(join(tree, 'm.mjs'), 'export const x = 41;\n');
    const outside = join(root, 'escape.txt');
    const before = readdirSync(tree, { recursive: true }).sort();
    try {
        // What a model did in a real run: fake a virtualenv and a sitecustomize in the tree.
        const out = snippet(tree, `
import { x } from './m.mjs';
import fs from 'node:fs';
console.log('import', x + 1, fs.readFileSync('m.mjs', 'utf8').trim());
const tries = {
    inside: () => fs.writeFileSync('inside.txt', 'ok'),
    mkdir: () => fs.mkdirSync('.venv/bin', { recursive: true }),
    nested: () => fs.writeFileSync('src/sitecustomize.py', 'x'),
    append: () => fs.appendFileSync('m.mjs', '// x'),
    symlink: () => fs.symlinkSync('/usr/bin/python3', 'python'),
    outside: () => fs.writeFileSync(${JSON.stringify(outside)}, 'x'),
    spawn: async () => (await import('node:child_process')).spawnSync(process.execPath, ['-e', '0']),
};
for (const [name, f] of Object.entries(tries)) {
    try { await f(); console.log(name, 'allowed'); } catch (e) { console.log(name, e.code); }
}`);
        assert.match(out, /import 42 export const x = 41;/);
        for (const name of ['inside', 'mkdir', 'nested', 'append', 'symlink', 'outside', 'spawn']) {
            assert.match(out, new RegExp(`^${name} ERR_ACCESS_DENIED$`, 'm'), `${name} is denied:\n${out}`);
        }
        assert.deepEqual(readdirSync(tree, { recursive: true }).sort(), before, 'the tree is untouched');
        assert.equal(readFileSync(join(tree, 'm.mjs'), 'utf8'), 'export const x = 41;\n');
        assert.ok(!existsSync(outside));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('a snippet can import a package hoisted to a node_modules above the tree, and read attached files, but nothing else', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'wgpt-sandbox-')));
    const tree = join(root, 'packages', 'app');
    mkdirSync(tree, { recursive: true });
    mkdirSync(join(root, 'node_modules', 'hoisted'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'hoisted', 'package.json'), '{"name":"hoisted","main":"index.js"}');
    writeFileSync(join(root, 'node_modules', 'hoisted', 'index.js'), 'module.exports = 7;\n');
    writeFileSync(join(root, 'spec.md'), 'the spec\n');
    writeFileSync(join(root, 'private.txt'), 'not for snippets\n');
    try {
        const args = runNodeArgs(tree, [join(root, 'spec.md')]);
        assert.ok(args.includes(`--allow-fs-read=${join(root, 'node_modules')}`), 'the hoisted node_modules is readable');
        assert.deepEqual(args.filter((a) => a.startsWith('--allow-fs-write')), [], 'no writes');
        const out = snippet(tree, `
import h from 'hoisted';
import { readFileSync } from 'node:fs';
console.log('hoisted', h);
console.log('spec', readFileSync(${JSON.stringify(join(root, 'spec.md'))}, 'utf8').trim());
try { readFileSync(${JSON.stringify(join(root, 'private.txt'))}); console.log('private allowed'); }
catch (e) { console.log('private', e.code); }`, [join(root, 'spec.md')]);
        assert.match(out, /hoisted 7/);
        assert.match(out, /spec the spec/);
        assert.match(out, /private ERR_ACCESS_DENIED/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
