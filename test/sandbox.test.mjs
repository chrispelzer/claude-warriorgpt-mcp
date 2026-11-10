// run_node snippets run under Node's permission model: inside the working directory only, no processes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runNodeArgs, PERMISSION_FLAG } from '../ask.mjs';

function snippet(cwd, code, readOnly) {
    const r = spawnSync(process.execPath, runNodeArgs(cwd, readOnly), { cwd, input: code, encoding: 'utf8' });
    return (r.stdout + r.stderr).trim();
}

test('run_node args: permission flag, reads in the tree and readOnly dirs, writes only in the tree', () => {
    const args = runNodeArgs('/w/copy', ['/w/orig']);
    assert.equal(args[0], PERMISSION_FLAG);
    assert.ok(args.includes('--allow-fs-read=/w/copy') && args.includes('--allow-fs-read=/w/orig'));
    assert.deepEqual(args.filter((a) => a.startsWith('--allow-fs-write')), ['--allow-fs-write=/w/copy']);
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
        assert.deepEqual(args.filter((a) => a.startsWith('--allow-fs-write')), [`--allow-fs-write=${link}`, `--allow-fs-write=${real}`]);
        writeFileSync(join(real, 'one.txt'), 'hello\n');
        assert.match(snippet(link, "import { readFileSync } from 'node:fs'; console.log(readFileSync('./one.txt', 'utf8'));"), /hello/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('a snippet can import and write in its tree, but cannot spawn or write outside it', () => {
    const root = mkdtempSync(join(tmpdir(), 'wgpt-sandbox-'));
    const tree = join(root, 'tree');
    mkdirSync(tree);
    writeFileSync(join(tree, 'm.mjs'), 'export const x = 41;\n');
    const outside = join(root, 'escape.txt');
    try {
        const out = snippet(tree, `
import { x } from './m.mjs';
import { writeFileSync } from 'node:fs';
writeFileSync('inside.txt', 'ok');
console.log('import', x + 1);
try { (await import('node:child_process')).spawnSync(process.execPath, ['-e', '0']); console.log('spawn allowed'); }
catch (e) { console.log('spawn', e.code); }
try { writeFileSync(${JSON.stringify(outside)}, 'x'); console.log('outside allowed'); }
catch (e) { console.log('outside', e.code); }`);
        assert.match(out, /import 42/);
        assert.match(out, /spawn ERR_ACCESS_DENIED/);
        assert.match(out, /outside ERR_ACCESS_DENIED/);
        assert.ok(existsSync(join(tree, 'inside.txt')));
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
        assert.deepEqual(args.filter((a) => a.startsWith('--allow-fs-write')), [`--allow-fs-write=${tree}`], 'still writes only in the tree');
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
