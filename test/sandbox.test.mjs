// run_node snippets run under Node's permission model: inside the working directory only, no processes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
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
