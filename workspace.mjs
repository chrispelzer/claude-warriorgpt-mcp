// Throwaway copies of the working tree, one per parallel attempt, so each attempt's edits can be checked
// without touching the real files. Files are reflinked where possible, never hard linked (an in-place rewrite
// would write through the link); .git is left out and node_modules is linked, not copied.

import { promises as fsp, constants, statSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, dirname, parse, isAbsolute } from 'node:path';

const SKIP = new Set(['.git']);
const COPY_PREFIX = 'wgpt-attempt-';
const LINK = new Set(['node_modules']);
// A tree bigger than this is not copied: the attempts run one at a time instead.
export const MAX_COPY_FILES = 5000;
export const MAX_COPY_BYTES = 200 * 1024 * 1024;

export class TooBigError extends Error {}

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
