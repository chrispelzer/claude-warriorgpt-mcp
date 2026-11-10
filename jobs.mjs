// Background jobs for the MCP server: a checked task runs for minutes, longer than a client waits on one tool call,
// so it starts as a job and the caller polls it. Jobs live in this process; finished ones are kept for KEEP_MS.

import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { CancelledError } from './ask.mjs';

export const DEFAULT_MAX_JOBS = 3;
export const KEEP_MS = 60 * 60 * 1000;
// Jobs waiting for a turn, beyond the ones running; past this a new one is refused.
const MAX_QUEUED = 20;
const LOG_LINES = 200;
const LINE_CHARS = 300;

const envMax = () => {
    const n = Number(process.env.WARRIORGPT_MAX_JOBS);
    return Number.isInteger(n) && n >= 1 ? n : DEFAULT_MAX_JOBS;
};

// The files a job may change. Two jobs that share one must not run together: a job that misses restores its
// files from its own snapshot, which would wipe the other's edits. Case is folded where file systems usually do.
const FOLD = process.platform === 'win32' || process.platform === 'darwin';
export function filesOf(args) {
    const paths = [...(Array.isArray(args?.files) ? args.files : []), ...(args?.output_file ? [args.output_file] : [])];
    return new Set(paths.filter((p) => typeof p === 'string' && p).map((p) => (FOLD ? resolve(p).toLowerCase() : resolve(p))));
}
const overlaps = (a, b) => [...a].some((f) => b.has(f));

// Progress read from the run's log lines: replies from one-shot attempts, the latest tool-loop step, retries (and
// when the next one goes out).
export function track(progress, line, now = Date.now()) {
    if (/--- (?:\[a\d+\] reply|attempt \d+(?: \(after [^)]*\))?: reply)/.test(line)) progress.replies++;
    const step = line.match(/(fix|verify) step (\d+) of (\d+)/);
    if (step) {
        const [, mode, n, of] = step;
        const lane = line.includes('[loop]') ? 'loop lane ' : '';
        progress.step = `${lane}${mode} step ${n} of ${of}`;
    }
    const retry = line.match(/WarriorGPT: (.*); retry (\d+) of (\d+) in ([\d.]+) s/);
    if (retry) {
        progress.retries++;
        progress.next_retry = { attempt: Number(retry[2]), of: Number(retry[3]), reason: retry[1].slice(0, 200),
            at: new Date(now + Number(retry[4]) * 1000).toISOString() };
    }
    const phase = line.match(/^=== (.{0,120})/);
    if (phase) progress.phase = phase[1];
}

// run(args, { signal, onLog }) does the work and resolves with its result, or throws.
export function createJobs({ run, maxRunning = envMax(), keepMs = KEEP_MS, now = Date.now } = {}) {
    const jobs = new Map();
    const waiting = [];
    const live = new Set();
    let running = 0;

    const prune = () => {
        const t = now();
        for (const [id, job] of jobs) if (job.finished && t - job.finished > keepMs) jobs.delete(id);
    };
    const settle = (job, state, fields) => {
        Object.assign(job, { state, finished: now(), ...fields });
        for (const w of job.waiters.splice(0)) w();
    };
    const begin = (job) => {
        running++;
        job.state = 'running';
        job.started = now();
        const onLog = (text) => {
            for (const raw of String(text).split('\n')) {
                const line = raw.trimEnd();
                if (!line) continue;
                track(job.progress, line);
                job.log.push(line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS)}...` : line);
                if (job.log.length > LOG_LINES) job.log.splice(0, job.log.length - LOG_LINES);
            }
        };
        job.promise = Promise.resolve()
            .then(() => run(job.args, { signal: job.ctl.signal, onLog }))
            .then((result) => settle(job, 'done', { result }),
                (error) => settle(job, error instanceof CancelledError || job.ctl.signal.aborted ? 'cancelled' : 'failed', { error }))
            .finally(() => {
                running--;
                live.delete(job);
                pump();
            });
    };
    // Starts waiting jobs in order while there is room, skipping any that shares a file with a running job or with
    // an earlier waiting one (so jobs on the same files run in the order they came).
    const pump = () => {
        const claimed = [...live].map((j) => j.files);
        for (const job of [...waiting]) {
            const blocker = [...live].find((j) => overlaps(j.files, job.files))
                || waiting.slice(0, waiting.indexOf(job)).find((j) => overlaps(j.files, job.files));
            if (running < maxRunning && !blocker && !claimed.some((f) => overlaps(f, job.files))) {
                waiting.splice(waiting.indexOf(job), 1);
                job.blockedBy = null;
                live.add(job);
                begin(job);
            } else {
                job.blockedBy = blocker?.id || null;
            }
            claimed.push(job.files);
        }
    };

    function start(args) {
        prune();
        if (running >= maxRunning && waiting.length >= MAX_QUEUED) {
            throw new Error(`${running} jobs running and ${waiting.length} waiting; wait for some to finish or cancel them.`);
        }
        const id = `wgpt-${randomBytes(4).toString('hex')}`;
        const job = { id, args, files: filesOf(args), blockedBy: null, state: 'queued', created: now(), started: null, finished: null,
            ctl: new AbortController(), log: [], waiters: [], progress: { replies: 0, step: null, retries: 0, phase: null, next_retry: null } };
        jobs.set(id, job);
        waiting.push(job);
        pump();
        return job;
    }

    const get = (id) => {
        prune();
        return jobs.get(id) || null;
    };

    // Resolves when the job is finished or ms have passed, whichever is first.
    const wait = (job, ms) => {
        if (job.finished || !(ms > 0)) return Promise.resolve();
        return new Promise((done) => {
            const t = setTimeout(done, ms);
            job.waiters.push(() => {
                clearTimeout(t);
                done();
            });
        });
    };

    // Asks the job to stop; a queued job stops at once, a running one once its run unwinds (files restored).
    function cancel(job) {
        if (job.finished) return;
        job.ctl.abort();
        if (job.state === 'queued') {
            waiting.splice(waiting.indexOf(job), 1);
            settle(job, 'cancelled', { error: new CancelledError('cancelled before it started') });
            pump();
        } else {
            job.state = 'cancelling';
        }
    }

    const list = () => {
        prune();
        return [...jobs.values()];
    };
    // Cancels every job and resolves once the running ones have unwound (their files restored).
    const cancelAll = () => {
        const all = list();
        all.forEach(cancel);
        return Promise.allSettled(all.map((j) => j.promise).filter(Boolean)).then(() => {});
    };

    const elapsedMs = (job) => (job.finished || now()) - (job.started || job.created);
    return { start, get, wait, cancel, cancelAll, list, elapsedMs, stats: () => ({ running, waiting: waiting.length, maxRunning }) };
}
