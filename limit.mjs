// One budget of WarriorGPT requests in flight per API key on this machine. The gateway allows each key only a few
// at once (6) and answers the rest with 429; every job, attempt and loop lane in this process draws from the same
// budget, and so does every other warriorgpt-mcp or warriorgpt-ask beside it, through lock files: one file per
// slot, created exclusively, removed on release. A holder touches its files while it runs, so the files of a
// process that died are taken over once its pid is gone or the file goes untouched for STALE_MS.

import { openSync, writeSync, closeSync, readFileSync, unlinkSync, mkdirSync, statSync, utimesSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { STATE_DIR } from './common.mjs';
import { sleep } from './retry.mjs';

export const DEFAULT_MAX_CONCURRENCY = 6;
const TOUCH_MS = 30_000;
export const STALE_MS = 4 * TOUCH_MS;
const POLL_MS = 150;

const alive = (pid) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return err.code === 'EPERM'; // someone else's process, but it exists
    }
};

// A slot file nobody holds any more: its process is gone (same host), or it has not been touched for STALE_MS.
function isStale(path, now = Date.now()) {
    let st;
    try { st = statSync(path); } catch { return false; } // already gone: the next create will tell
    if (now - st.mtimeMs > STALE_MS) return true;
    try {
        const holder = JSON.parse(readFileSync(path, 'utf8'));
        return holder.host === hostname() && Number.isInteger(holder.pid) && !alive(holder.pid);
    } catch {
        return false; // being written right now, or unreadable: trust the age check
    }
}

export function parseMax(value) {
    if (value === undefined || value === null || value === '') return null;
    const n = Number(value);
    return Number.isInteger(n) && n >= 0 ? n : null;
}

// max 0 turns the limit off. dir null keeps it to this process (no lock files).
export function createLimiter({ max = DEFAULT_MAX_CONCURRENCY, dir = null, onNote = () => {} } = {}) {
    let active = 0;
    const queue = [];
    const held = new Map(); // path -> token
    let toucher = null;
    let shared = !!dir;

    const touch = () => {
        const now = new Date();
        for (const path of held.keys()) {
            try { utimesSync(path, now, now); } catch { /* removed under us: release will notice */ }
        }
    };
    const dropAll = () => {
        for (const [path, token] of held) dropFile(path, token);
    };
    const dropFile = (path, token) => {
        held.delete(path);
        try {
            if (JSON.parse(readFileSync(path, 'utf8')).token === token) unlinkSync(path);
        } catch { /* already gone, or taken over as stale */ }
        if (!held.size && toucher) {
            clearInterval(toucher);
            toucher = null;
        }
    };
    // One free slot file, or null when all are held.
    const tryFiles = () => {
        for (let i = 0; i < max; i++) {
            const path = join(dir, `slot-${i}`);
            for (let tries = 0; tries < 2; tries++) {
                let fd;
                try {
                    fd = openSync(path, 'wx');
                } catch (err) {
                    if (err.code !== 'EEXIST') throw err;
                    if (tries === 0 && isStale(path)) {
                        try { unlinkSync(path); } catch { /* another process took it over first */ }
                        continue;
                    }
                    break;
                }
                const token = randomBytes(8).toString('hex');
                try {
                    writeSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), token, since: new Date().toISOString() }));
                } finally {
                    closeSync(fd);
                }
                held.set(path, token);
                if (!toucher) {
                    toucher = setInterval(touch, TOUCH_MS);
                    toucher.unref();
                }
                return { path, token };
            }
        }
        return null;
    };
    const fileSlot = async (signal) => {
        if (!shared) return null;
        try {
            mkdirSync(dir, { recursive: true });
            for (;;) {
                const got = tryFiles();
                if (got) return got;
                await sleep(POLL_MS / 2 + Math.random() * POLL_MS, signal);
            }
        } catch (err) {
            if (signal?.aborted) throw err;
            // A folder we cannot write: keep the limit to this process rather than fail the request.
            shared = false;
            onNote(`request limit: cannot use lock files in ${dir} (${err.message}); limiting this process only`);
            return null;
        }
    };
    const leave = () => {
        active--;
        while (queue.length && active < max) {
            const next = queue.shift();
            if (next.gone) continue;
            active++;
            next.go();
        }
    };

    // Waits for a slot (in this process, then on this machine) and returns its release function; a signal that
    // aborts while it waits rejects with the signal's reason.
    async function acquire(signal) {
        if (signal?.aborted) throw signal.reason;
        if (!max) return () => {};
        if (active < max) active++;
        else {
            await new Promise((go, fail) => {
                const entry = { go: () => { signal?.removeEventListener('abort', onAbort); go(); }, gone: false };
                const onAbort = () => {
                    entry.gone = true;
                    fail(signal.reason);
                };
                signal?.addEventListener('abort', onAbort, { once: true });
                queue.push(entry);
            });
        }
        let file;
        try {
            file = await fileSlot(signal);
        } catch (err) {
            leave();
            throw err;
        }
        let released = false;
        return () => {
            if (released) return;
            released = true;
            if (file) dropFile(file.path, file.token);
            leave();
        };
    }

    return { acquire, dropAll, stats: () => ({ active, waiting: queue.filter((q) => !q.gone).length, max, shared }) };
}

// The process-wide limiter, made on first use so a --max-concurrency flag can set it first.
let limiter = null;
let configured = null;
export function setMaxConcurrency(n) {
    const v = parseMax(n);
    if (v === null) throw new Error(`max concurrency must be a whole number >= 0, not ${n}`);
    configured = v;
    limiter = null;
}
export const maxConcurrency = () => configured ?? parseMax(process.env.WARRIORGPT_MAX_CONCURRENCY) ?? DEFAULT_MAX_CONCURRENCY;

export function requestSlot(key, signal) {
    if (!limiter) {
        // One folder per API key (by hash): the gateway's cap is per key.
        const dir = join(STATE_DIR, `slots-${createHash('sha256').update(key).digest('hex').slice(0, 12)}`);
        limiter = createLimiter({ max: maxConcurrency(), dir, onNote: (t) => process.stderr.write(`warriorgpt: ${t}\n`) });
        const current = limiter;
        process.once('exit', () => current.dropAll());
    }
    return limiter.acquire(signal);
}
