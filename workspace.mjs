// Throwaway copies of the working tree, one per parallel attempt, so each attempt's edits can be checked
// without touching the real files. Files are reflinked where possible, never hard linked (an in-place rewrite
// would write through the link); .git is left out and node_modules is linked, not copied.

import { promises as fsp, constants, statSync, existsSync, unlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, dirname, parse, isAbsolute, delimiter, basename, sep } from 'node:path';
import { execFile } from 'node:child_process';

const SKIP = new Set(['.git']);
const COPY_PREFIX = 'wgpt-attempt-';
const LINK = new Set(['node_modules']);
// A tree bigger than this is not copied: the attempts run one at a time instead.
export const MAX_COPY_FILES = 5000;
export const MAX_COPY_BYTES = 200 * 1024 * 1024;

// The tree cannot be copied safely: the attempts run one at a time in the tree itself.
export class CantCopyError extends Error {}
export class TooBigError extends CantCopyError {}

function sameVolume(a, b) {
    if (process.platform === 'win32') return parse(a).root.toLowerCase() === parse(b).root.toLowerCase();
    try {
        return statSync(a).dev === statSync(b).dev;
    } catch {
        return false;
    }
}

export function inside(root, path) {
    const rel = relative(root, path);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

async function survey(root) {
    const files = [];
    const links = [];
    let bytes = 0;
    const walk = async (dir) => {
        for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
            const abs = join(dir, e.name);
            if (SKIP.has(e.name) || (e.isDirectory() && e.name.startsWith(COPY_PREFIX))) continue; // never copy a copy
            if (LINK.has(e.name) && e.isDirectory()) {
                links.push(abs);
                continue;
            }
            if (e.isSymbolicLink()) {
                // A linked folder or a broken link cannot be copied as a file, and linking it would share it.
                const to = await fsp.stat(abs).catch(() => null);
                if (!to?.isFile()) {
                    throw new CantCopyError(`the working tree has a ${to ? 'linked folder' : 'broken link'} (${relative(root, abs)})`);
                }
            }
            if (e.isDirectory()) await walk(abs);
            else if (e.isFile() || e.isSymbolicLink()) {
                files.push(abs);
                bytes += (await fsp.stat(abs).catch(() => ({ size: 0 }))).size;
                if (files.length > MAX_COPY_FILES || bytes > MAX_COPY_BYTES) {
                    throw new TooBigError(`the working tree is too big to copy (over ${MAX_COPY_FILES} files or ` +
                        `${MAX_COPY_BYTES / 1024 / 1024} MB, not counting .git and node_modules)`);
                }
            }
        }
    };
    await walk(root);
    return { files, links };
}

export async function makeCopy(root) {
    // The temp folder if it is on the same volume (cheap copies) and not inside the tree itself; else beside the tree.
    const base = sameVolume(tmpdir(), root) && !inside(root, tmpdir()) ? tmpdir() : dirname(root);
    const dir = await fsp.mkdtemp(join(base, COPY_PREFIX));
    const made = [];
    try {
        const { files, links } = await survey(root);
        const dirs = new Set(files.map((f) => dirname(join(dir, relative(root, f)))));
        await Promise.all([...dirs].map((d) => fsp.mkdir(d, { recursive: true })));
        // A few dozen copies at a time: enough to overlap the I/O without running out of file handles.
        for (let i = 0; i < files.length; i += 64) {
            await Promise.all(files.slice(i, i + 64).map((f) =>
                fsp.copyFile(f, join(dir, relative(root, f)), constants.COPYFILE_FICLONE)));
        }
        for (const l of links) {
            const at = join(dir, relative(root, l));
            await fsp.mkdir(dirname(at), { recursive: true });
            await fsp.symlink(l, at, process.platform === 'win32' ? 'junction' : 'dir');
            made.push(at);
        }
    } catch (err) {
        await removeCopy(dir, made);
        throw err;
    }
    return {
        dir,
        to: (path) => join(dir, relative(root, path)),
        cleanup: () => removeCopy(dir, made),
    };
}

// Links are removed first, on their own, so the recursive delete can never reach into the linked folders.
async function removeCopy(dir, links) {
    for (const l of links) {
        try {
            unlinkSync(l);
        } catch {
            // already gone
        }
    }
    if (links.some((l) => existsSync(l))) return; // never delete through a link we could not remove
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
}

// A check run in a copy still imports whatever its environment points at: a Python package installed in editable
// mode resolves to the real tree, so the copy's edits would go untested. The copy's src/ and root go first on
// PYTHONPATH, ahead of any existing value.
export function copyEnv(dir, base = process.env) {
    const src = join(dir, 'src');
    return { PYTHONPATH: [...(existsSync(src) ? [src] : []), dir, ...(base.PYTHONPATH ? [base.PYTHONPATH] : [])].join(delimiter) };
}

const real = (p) => {
    try { return realpathSync(p); } catch { return p; }
};
const PROBE_MS = 10000;
// find_spec locates a module without running it.
const PY_PROBE = `import importlib.util, json, sys
out = {}
for n in sys.argv[1:]:
    try:
        s = importlib.util.find_spec(n)
    except Exception:
        s = None
    out[n] = (s.origin or next(iter(s.submodule_search_locations or []), None)) if s else None
print(json.dumps(out))`;

// The top-level Python packages and modules that hold a task file: src/pkg/..., pkg/... (with __init__.py), or a
// lone module file in src/ or the root. Test files are not code under test.
export function pythonModules(dir, files) {
    const names = new Set();
    for (const f of files) {
        const parts = relative(dir, f).split(sep);
        if (parts[0] === '..' || isAbsolute(parts[0]) || !f.endsWith('.py')) continue;
        const at = parts[0] === 'src' ? 1 : 0;
        const rest = parts.slice(at);
        const name = rest.length === 1 ? basename(rest[0], '.py') : rest[0];
        if (!/^[A-Za-z_]\w*$/.test(name) || /^(test_|conftest$|setup$|noxfile$)/.test(name) || name === 'tests') continue;
        if (rest.length > 1 && !existsSync(join(dir, ...parts.slice(0, at + 1), '__init__.py'))) continue;
        names.add(name);
    }
    return [...names];
}

// The interpreter the check most likely uses: its own first word if that is a python, else a virtualenv in the
// copy or the active one, else python3 (python on Windows) from PATH.
export function pythonFor(dir, check = '') {
    const first = (check.match(/^\s*(?:"([^"]+)"|(\S+))/) || []).slice(1).find(Boolean) || '';
    if (/(^|[/\\])python(3(\.\d+)?)?(\.exe)?$/i.test(first)) return isAbsolute(first) || !/[/\\]/.test(first) ? first : join(dir, first);
    const win = process.platform === 'win32';
    const venvs = [join(dir, '.venv'), join(dir, 'venv'), ...(process.env.VIRTUAL_ENV ? [process.env.VIRTUAL_ENV] : [])];
    for (const v of venvs) {
        const py = win ? join(v, 'Scripts', 'python.exe') : join(v, 'bin', 'python');
        if (existsSync(py)) return py;
    }
    return win ? 'python' : 'python3';
}

function pyProbe(py, dir, names, env) {
    return new Promise((done) => {
        execFile(py, ['-c', PY_PROBE, ...names], { cwd: dir, env, timeout: PROBE_MS, windowsHide: true }, (err, stdout) => {
            if (err) return done(null);
            try { done(JSON.parse(stdout.trim().split('\n').at(-1))); } catch { done(null); }
        });
    });
}

// Packages in the tree's node_modules that link back into the real tree (workspaces, npm link): code in a copy that
// imports them by name runs the real files. Only the top level of node_modules is looked at.
async function linkedPackages(root, files) {
    const nm = join(root, 'node_modules');
    const found = [];
    const entries = await fsp.readdir(nm, { withFileTypes: true }).catch(() => []);
    const names = [];
    for (const e of entries) {
        if (e.name.startsWith('@') && e.isDirectory()) {
            for (const s of await fsp.readdir(join(nm, e.name), { withFileTypes: true }).catch(() => [])) {
                if (s.isSymbolicLink()) names.push(`${e.name}/${s.name}`);
            }
        } else if (e.isSymbolicLink()) names.push(e.name);
    }
    const realRoot = real(root);
    const realNm = real(nm);
    for (const name of names) {
        const to = real(join(nm, name));
        if (!inside(realRoot, to) || inside(realNm, to)) continue;
        const hit = files.find((f) => inside(to, real(f)));
        if (hit) found.push(`node_modules/${name} links to ${to} in the real tree, so a check in a copy that imports "${name}" runs the original ${relative(realRoot, real(hit))}, not the edits`);
    }
    return found;
}

// Before the first check in a copy: does the code under test resolve outside it? Best-effort and time-boxed;
// returns warnings (empty when all is well or nothing could be probed). root: the real tree; dir: the copy.
export async function probeCopy({ root, dir, files, check = '', env = {} }) {
    const warnings = [];
    try {
        const names = pythonModules(root, files);
        if (names.length) {
            const childEnv = { ...process.env, ...env };
            delete childEnv.WARRIORGPT_API_KEY;
            const where = await pyProbe(pythonFor(dir, check), dir, names, childEnv);
            const realDir = real(dir);
            for (const [name, at] of Object.entries(where || {})) {
                if (!at || inside(realDir, real(at))) continue;
                const inReal = inside(real(root), real(at));
                warnings.push(`Python imports ${name} from ${at}${inReal ? ', in the real tree' : ''}, not from the copy: a check ` +
                    'in a copy tests the original code, not the edits (an editable install, or an environment that overrides PYTHONPATH)');
            }
        }
        warnings.push(...await linkedPackages(root, files));
    } catch {
        // best-effort
    }
    return warnings;
}

// Check output with what differs between runs of the same failure taken out: copy paths, the tree's own path,
// timings and object addresses.
export function normalizeOutput(text, dirs = []) {
    let t = String(text || '').trim();
    for (const d of dirs.filter(Boolean)) {
        for (const v of new Set([d, real(d), d.replace(/\\/g, '/')])) t = t.split(v).join('<tree>');
    }
    return t.replace(/[^\s"'(]*wgpt-attempt-[A-Za-z0-9]+/g, '<tree>')
        .replace(/\bduration_ms[:=\s]+[\d.]+/g, 'duration_ms <t>')
        .replace(/\b\d+(?:\.\d+)?\s?(?:ms|s|sec|secs|seconds)\b/g, '<t>')
        .replace(/\b0x[0-9a-f]{6,}\b/gi, '0x<addr>');
}

// The number of check runs when there are at least two, all failed, all with the same normalized output; else 0.
export function sameFailure(runs, dirs = []) {
    if (runs.length < 2 || runs.some((r) => r.ok)) return 0;
    const key = (r) => `${r.timedOut ? 'timed out' : r.code}\n${normalizeOutput(r.output, dirs)}`;
    return new Set(runs.map(key)).size === 1 ? runs.length : 0;
}
