// Checks run in a copy of the tree: the copy's code must be what they test (PYTHONPATH, the import probe), and a
// failure that never changes points at the check, not the model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { makeCopy, copyEnv, probeCopy, pythonModules, pythonFor, normalizeOutput, sameFailure } from '../workspace.mjs';

const PY = pythonFor('');
// Windows may have only the Store stub for python, which runs but is not Python.
const probe = spawnSync(PY, ['--version'], { encoding: 'utf8' });
const hasPython = !probe.error && probe.status === 0 && /Python 3/.test(probe.stdout + probe.stderr);

// A src-layout Python project: src/pkg/__init__.py and src/pkg/core.py, with a test beside it.
function pyTree() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'warriorgpt-checks-test-')));
    mkdirSync(join(root, 'src', 'pkg'), { recursive: true });
    mkdirSync(join(root, 'tests'));
    writeFileSync(join(root, 'src', 'pkg', '__init__.py'), '');
    writeFileSync(join(root, 'src', 'pkg', 'core.py'), 'def f():\n    return 1\n');
    writeFileSync(join(root, 'tests', 'test_core.py'), 'from pkg.core import f\n');
    return root;
}

test('copyEnv: the copy\'s src/ and root go first on PYTHONPATH, ahead of the existing value', () => {
    const root = pyTree();
    try {
        assert.deepEqual(copyEnv(root, { PYTHONPATH: '/elsewhere' }).PYTHONPATH.split(delimiter), [join(root, 'src'), root, '/elsewhere']);
        rmSync(join(root, 'src'), { recursive: true });
        assert.equal(copyEnv(root, {}).PYTHONPATH, root, 'no src/: just the root, and nothing empty');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('pythonModules: the top-level packages and modules that hold a task file, not tests', () => {
    const root = pyTree();
    writeFileSync(join(root, 'tool.py'), '');
    mkdirSync(join(root, 'loose'));
    try {
        const files = ['src/pkg/core.py', 'tests/test_core.py', 'tool.py', 'conftest.py', 'loose/x.py', 'README.md'].map((f) => join(root, f));
        assert.deepEqual(pythonModules(root, files), ['pkg', 'tool'], 'loose/ has no __init__.py, so it is not a package');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('probe: warns when the package under test resolves to the real tree, not with the copy first on PYTHONPATH', { skip: !hasPython && `${PY} not found` }, async () => {
    const root = pyTree();
    const copy = await makeCopy(root);
    const files = [join(root, 'src', 'pkg', 'core.py')];
    // An editable install, as PYTHONPATH pointing at the real src/ stands in for it.
    const editable = { PYTHONPATH: join(root, 'src') };
    try {
        const bad = await probeCopy({ root, dir: copy.dir, files, env: editable });
        assert.equal(bad.length, 1, bad.join('\n'));
        assert.match(bad[0], /^Python imports pkg from .*__init__\.py, in the real tree, not from the copy/);
        assert.ok(bad[0].includes(join(root, 'src', 'pkg')));
        const good = await probeCopy({ root, dir: copy.dir, files, env: copyEnv(copy.dir, editable) });
        assert.deepEqual(good, [], 'with the copy first on PYTHONPATH the copy is what gets imported');
    } finally {
        await copy.cleanup();
        rmSync(root, { recursive: true, force: true });
    }
});

test('probe: an import hook that wins over PYTHONPATH is caught too', { skip: !hasPython && `${PY} not found` }, async () => {
    const root = pyTree();
    const copy = await makeCopy(root);
    // Some editable installs put a finder in front of the path search; sitecustomize stands in for one.
    const site = mkdtempSync(join(tmpdir(), 'warriorgpt-checks-site-'));
    writeFileSync(join(site, 'sitecustomize.py'), `import sys, importlib.util
class Redirect:
    def find_spec(self, name, path=None, target=None):
        if name == 'pkg':
            return importlib.util.spec_from_file_location('pkg', ${JSON.stringify(join(root, 'src', 'pkg', '__init__.py'))},
                submodule_search_locations=[${JSON.stringify(join(root, 'src', 'pkg'))}])
sys.meta_path.insert(0, Redirect())
`);
    try {
        const found = await probeCopy({ root, dir: copy.dir, files: [join(root, 'src', 'pkg', 'core.py')], env: copyEnv(copy.dir, { PYTHONPATH: site }) });
        assert.equal(found.length, 1, 'PYTHONPATH alone cannot fix this, so the probe must say so');
        assert.match(found[0], /in the real tree, not from the copy/);
    } finally {
        await copy.cleanup();
        rmSync(root, { recursive: true, force: true });
        rmSync(site, { recursive: true, force: true });
    }
});

test('probe: no Python package and no linked package means nothing to say, and nothing is run', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'warriorgpt-checks-test-')));
    writeFileSync(join(root, 'a.js'), '');
    try {
        // A python that does not exist would make a probe fail; it is never started.
        assert.deepEqual(await probeCopy({ root, dir: root, files: [join(root, 'a.js')], check: '/nowhere/python -m pytest' }), []);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('probe: a workspace package linked from node_modules back into the real tree is reported', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'warriorgpt-checks-test-')));
    mkdirSync(join(root, 'packages', 'lib'), { recursive: true });
    mkdirSync(join(root, 'node_modules', '@me'), { recursive: true });
    writeFileSync(join(root, 'packages', 'lib', 'index.js'), 'export const x = 1;\n');
    symlinkSync(join(root, 'packages', 'lib'), join(root, 'node_modules', '@me', 'lib'), 'junction');
    const copy = await makeCopy(root);
    try {
        const found = await probeCopy({ root, dir: copy.dir, files: [join(root, 'packages', 'lib', 'index.js')] });
        assert.equal(found.length, 1);
        assert.match(found[0], /^node_modules\/@me\/lib links to .* in the real tree, so a check in a copy that imports "@me\/lib" runs the original packages[/\\]lib[/\\]index\.js/);
        assert.deepEqual(await probeCopy({ root, dir: copy.dir, files: [join(root, 'other.js')] }), [], 'not a task file: no warning');
    } finally {
        await copy.cleanup();
        rmSync(root, { recursive: true, force: true });
    }
});

test('normalizeOutput and sameFailure: copy paths and timings do not make two failures different', () => {
    const a = { ok: false, code: 1, output: 'FAILED /tmp/wgpt-attempt-abc123/tests/test_core.py::test_f - assert 1 == 2\n1 failed in 0.05s\n' };
    const b = { ok: false, code: 1, output: '  FAILED /tmp/wgpt-attempt-XYZ789/tests/test_core.py::test_f - assert 1 == 2\n1 failed in 0.31s' };
    const real = { ok: false, code: 1, output: 'FAILED /home/me/proj/tests/test_core.py::test_f - assert 1 == 2\n1 failed in 12ms' };
    assert.equal(normalizeOutput(a.output), normalizeOutput(b.output));
    assert.equal(sameFailure([a, b, real], ['/home/me/proj']), 3);
    assert.equal(sameFailure([a]), 0, 'one run says nothing');
    assert.equal(sameFailure([a, { ...b, output: b.output.replace('1 == 2', '2 == 3') }]), 0, 'different output');
    assert.equal(sameFailure([a, { ...b, code: 2 }]), 0, 'different exit code');
    assert.equal(sameFailure([a, { ...b, ok: true }]), 0, 'a pass');
});
