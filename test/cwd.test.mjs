// The check's default folder (the project root) and checks that cannot run at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { defaultCwd, checkProgram, programFound, cannotRun } from '../ask.mjs';

function project() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'warriorgpt-cwd-test-')));
    const proj = join(root, 'proj');
    mkdirSync(join(proj, 'src', 'pkg'), { recursive: true });
    mkdirSync(join(proj, 'tests'));
    return { root, proj, file: join(proj, 'src', 'pkg', '__init__.py'), test: join(proj, 'tests', 'test_x.py') };
}

test('defaultCwd: the nearest folder above the files with a project marker', () => {
    const { root, proj, file, test: t } = project();
    try {
        for (const marker of ['pyproject.toml', '.git', 'package.json', 'Makefile']) {
            const at = join(proj, marker);
            if (marker === '.git') mkdirSync(at); else writeFileSync(at, '');
            const got = defaultCwd([file], '/elsewhere', '/home/nobody');
            assert.equal(got.dir, proj, marker);
            assert.match(got.why, new RegExp(`project root.*${marker.replace('.', '\\.')}`));
            rmSync(at, { recursive: true });
        }
        writeFileSync(join(proj, 'src', 'pkg', 'package.json'), '{}');
        assert.equal(defaultCwd([file], '/elsewhere', '/home/nobody').dir, join(proj, 'src', 'pkg'), 'the nearest marker wins');
        rmSync(join(proj, 'src', 'pkg', 'package.json'));
        writeFileSync(join(proj, 'setup.cfg'), '');
        assert.equal(defaultCwd([file, t], '/elsewhere', '/home/nobody').dir, proj, 'several files: from their common folder');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('defaultCwd: no marker falls back to the current folder if it holds the files, else their common folder', () => {
    const { root, proj, file } = project();
    try {
        assert.deepEqual(defaultCwd([file], proj, '/home/nobody'), { dir: proj, why: 'the current folder, which holds the files' });
        assert.equal(defaultCwd([file], '/elsewhere', '/home/nobody').dir, join(proj, 'src', 'pkg'));
        // A marker above the current folder is not used when the files are under it, and the home folder never is.
        writeFileSync(join(root, 'package.json'), '{}');
        assert.equal(defaultCwd([file], proj, '/home/nobody').dir, proj);
        assert.equal(defaultCwd([file], '/elsewhere', root).dir, join(proj, 'src', 'pkg'), 'the home folder is not a project');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('checkProgram: the first word after VAR=value settings; none for shell builtins', () => {
    assert.equal(checkProgram('.venv/bin/python -m unittest discover -s tests'), '.venv/bin/python');
    assert.equal(checkProgram('CI=1 FOO=bar npm test'), 'npm');
    assert.equal(checkProgram('"/opt/my tools/run" --x'), '/opt/my tools/run');
    assert.equal(checkProgram('cd sub && npm test'), null);
    assert.equal(checkProgram('(npm test)'), null);
});

test('programFound: a path from cwd, a bare name on PATH', () => {
    const { root, proj } = project();
    try {
        mkdirSync(join(proj, '.venv', 'bin'), { recursive: true });
        writeFileSync(join(proj, '.venv', 'bin', 'python'), '');
        assert.equal(programFound('.venv/bin/python', proj), true);
        assert.equal(programFound('.venv/bin/python', join(proj, 'src')), false, 'relative to cwd, not the files');
        assert.equal(programFound('python', proj, { PATH: [join(proj, 'nowhere'), join(proj, '.venv', 'bin')].join(delimiter) }, 'linux'), true);
        assert.equal(programFound('no-such-tool-here', proj, { PATH: join(proj, '.venv', 'bin') }, 'linux'), false);
        assert.equal(programFound('node', proj, { PATH: '' }), true, 'node is this Node binary');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('cannotRun: the program failing to start, not tests that fail', () => {
    const p = '.venv/bin/python';
    assert.equal(cannotRun({ ok: false, code: 127, output: '/bin/sh: .venv/bin/python: No such file or directory' }, p),
        '/bin/sh: .venv/bin/python: No such file or directory');
    assert.match(cannotRun({ ok: false, code: 126, output: 'sh: ./run-tests: Permission denied' }, './run-tests'), /Permission denied/);
    assert.match(cannotRun({ ok: false, code: -2, output: 'spawn /x/pytest ENOENT' }, '/x/pytest'), /ENOENT/);
    assert.equal(cannotRun({ ok: false, code: 1, output: 'FileNotFoundError: No such file or directory: data.csv' }, p), '',
        'a test that cannot find its data is a failing test');
    assert.equal(cannotRun({ ok: false, code: 127, output: 'helper.sh: command not found' }, p), '', 'something else the suite runs');
    assert.equal(cannotRun({ ok: true, code: 0, output: '' }, p), '');
});
