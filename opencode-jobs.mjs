// Runs warriorgpt-delegate (the sealed OpenCode worker) as a child process and turns its exit code, stdout and
// summary.json into one result object, for start_opencode_job and for the fallback when a checked ask never passes.

import { randomBytes } from 'node:crypto';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsageError, CancelledError } from './ask.mjs';

const DELEGATE = fileURLToPath(new URL('./warriorgpt-delegate.mjs', import.meta.url));

// This module shells out to git in arbitrary directories. GIT_DIR and its friends would steer every one of
// those calls to the wrong repository, so they are dropped from the inherited environment at load time.
const GIT_ENV_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR'];
for (const v of GIT_ENV_VARS) delete process.env[v];

function gitEnv(extra = {}) {
    const env = { ...process.env, ...extra };
    for (const v of GIT_ENV_VARS) if (!(v in extra)) delete env[v];
    return env;
}
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,60}$/;
const VERDICTS = {
    0: 'done', 1: 'failed', 2: 'refused (usage)', 3: 'model unreachable', 4: 'needs input',
    8: 'timed out', 9: 'no change made', 10: 'partial or blocked',
};

// A fresh task id: the prefix plus six random lower-case letters or digits.
export function taskName(prefix = 'oc') {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = randomBytes(6);
    return `${prefix}-${[...bytes].map((b) => alphabet[b % alphabet.length]).join('')}`;
}

const gitOut = (cwd, args, env) => {
    try {
        return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: gitEnv(env) }).trimEnd();
    } catch {
        return null;
    }
};

// A commit holding the working tree of the repository that contains dir, untracked-but-not-ignored files included,
// built in a throwaway index so the user's index, HEAD, refs, stash and files are never touched.
export function snapshotBase(dir) {
    const top = gitOut(dir, ['rev-parse', '--show-toplevel']);
    if (!top) return null;
    if (!gitOut(top, ['status', '--porcelain'])) return null;
    const tmp = mkdtempSync(join(tmpdir(), 'warriorgpt-snap-'));
    const env = gitEnv({ GIT_INDEX_FILE: join(tmp, 'index') });
    // commit-tree needs an identity; keep the caller's when it has one.
    for (const [varName, value] of [['GIT_AUTHOR_NAME', 'warriorgpt'], ['GIT_AUTHOR_EMAIL', 'warriorgpt@localhost'],
        ['GIT_COMMITTER_NAME', 'warriorgpt'], ['GIT_COMMITTER_EMAIL', 'warriorgpt@localhost']]) {
        if (!(varName in process.env)) env[varName] = value;
    }
    try {
        gitOut(top, ['read-tree', 'HEAD'], env);
        gitOut(top, ['add', '-A'], env);
        const tree = gitOut(top, ['write-tree'], env);
        if (!tree) return null;
        return gitOut(top, ['commit-tree', tree, '-p', 'HEAD', '-m', 'warriorgpt: snapshot of uncommitted work'], env);
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
}

// A brief that stands alone, for a worker taking over a task whose check never passed.
export function fallbackBrief({ prompt, files, check, cwd, root, failure }) {
    const rel = (p) => relative(root, p).split(sep).join('/');
    const parts = ['# Task', '', String(prompt ?? ''), '', '## Files to change'];
    for (const f of files || []) parts.push(`- ${rel(f)}`);
    parts.push('', '## Check');
    const from = cwd && resolve(cwd) !== resolve(root) ? ` from \`${rel(cwd)}\`` : '';
    parts.push(`Run \`${check}\`${from} and it must pass before you finish.`);
    parts.push('Commit your work on your branch when it passes.');
    parts.push('', '## What happened before');
    parts.push('A one-shot model tried this task and its check never passed; its edits were undone.');
    const last = String(failure ?? '');
    parts.push(last.length > 4000 ? `${last.slice(0, 4000)}...` : last);
    return parts.join('\n') + '\n';
}

// Runs the delegate for one task. Every bad argument throws UsageError before anything is spawned.
export async function runOpenCode(args, { signal, onLog } = {}, { nodeArgs = process.execArgv, env = {} } = {}) {
    const a = args || {};
    const reply = a.reply;
    if (reply !== undefined && (typeof reply !== 'string' || !reply)) throw new UsageError('reply must be a non-empty string');
    if (!reply && (typeof a.brief !== 'string' || !a.brief)) throw new UsageError('brief is required and must be non-empty unless reply is given');
    const dir = a.dir;
    if (typeof dir !== 'string' || !isAbsolute(dir)) throw new UsageError(`dir must be an absolute path: ${dir}`);
    if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new UsageError(`dir is not a directory: ${dir}`);
    const mode = a.mode ?? 'write';
    if (mode !== 'write' && mode !== 'read') throw new UsageError(`mode must be write or read: ${mode}`);
    const name = a.name ?? taskName('oc');
    if (!NAME_RE.test(name)) throw new UsageError(`name must match ${NAME_RE}: ${name}`);
    if (reply && a.name === undefined) throw new UsageError('reply needs name');
    const model = a.model;
    if (model !== undefined) {
        if (typeof model !== 'string' || !model) throw new UsageError('model must be a non-empty string');
        const slash = model.indexOf('/');
        if (slash >= 0 && model.slice(0, slash) !== 'warriorgpt') {
            throw new UsageError(`model must be a WarriorGPT model (warriorgpt/<id> or <id>): ${model}`);
        }
    }
    const timeout = a.timeout_min ?? 30;
    if (typeof timeout !== 'number' || !Number.isFinite(timeout) || !(timeout > 0) || timeout > 240) {
        throw new UsageError(`timeout_min must be a number of minutes with 0 < t <= 240: ${timeout}`);
    }
    const instructions = a.instructions ?? [];
    if (!Array.isArray(instructions)) throw new UsageError('instructions must be an array of file paths');
    for (const f of instructions) {
        if (typeof f !== 'string' || !isAbsolute(f)) throw new UsageError(`instruction file must be an absolute path: ${f}`);
        if (!existsSync(f)) throw new UsageError(`instruction file does not exist: ${f}`);
    }
    const includeUncommitted = a.include_uncommitted !== false;

    const briefDir = mkdtempSync(join(tmpdir(), 'warriorgpt-oc-'));
    const briefFile = join(briefDir, 'brief.md');
    try {
        writeFileSync(briefFile, reply || a.brief);

        // The worker starts from a snapshot of uncommitted work unless told otherwise or resuming a task.
        let base = null;
        const usedSnapshot = (() => {
            if (mode !== 'write' || reply || !includeUncommitted) return false;
            base = snapshotBase(dir);
            return Boolean(base);
        })();

        if (signal?.aborted) throw new CancelledError('cancelled');
        const childArgs = [
            ...nodeArgs, DELEGATE,
            '--name', name, '--brief', briefFile, '--dir', dir, '--mode', mode, '--timeout', String(timeout),
            ...(model ? ['--model', model] : []),
            ...(base ? ['--base', base] : []),
            ...instructions.flatMap((f) => ['--instructions', f]),
            ...(reply ? ['--continue', '--resume'] : []),
        ];
        const child = spawn(process.execPath, childArgs,
            { cwd: dir, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

        let cancelled = false;
        const onAbort = () => {
            if (cancelled) return;
            cancelled = true;
            // Kill the whole tree: OpenCode runs under the delegate.
            if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)]);
            else child.kill('SIGTERM');
        };
        if (signal) signal.addEventListener('abort', onAbort, { once: true });

        let stdout = '', stderr = '', rest = '';
        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString('utf8');
            rest += chunk.toString('utf8');
            let i;
            while ((i = rest.indexOf('\n')) >= 0) {
                const line = rest.slice(0, i);
                rest = rest.slice(i + 1);
                onLog?.(line);
            }
        });
        child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

        const exit = await new Promise((resolveExit, rejectExit) => {
            child.on('error', rejectExit);
            child.on('exit', (code) => {
                if (cancelled) rejectExit(new CancelledError('cancelled'));
                else resolveExit(code ?? 1);
            });
        });
        signal?.removeEventListener('abort', onAbort);

        // The delegate announces its run folder early on stdout; the path is the rest of that line.
        let runDir = null;
        const marker = `warriorgpt-delegate: ${name} -> `;
        for (const line of stdout.split('\n')) {
            if (!line.startsWith(marker)) continue;
            const at = line.lastIndexOf('run folder ');
            if (at >= 0) { runDir = line.slice(at + 'run folder '.length).trim(); break; }
        }
        let summary = null;
        if (runDir && existsSync(join(runDir, 'summary.json'))) {
            try {
                summary = JSON.parse(readFileSync(join(runDir, 'summary.json'), 'utf8'));
            } catch {
                summary = null;
            }
        }

        const verdict = VERDICTS[exit] || 'failed';
        const parts = [`OpenCode job ${name}: ${verdict} (exit ${exit})`, stdout.trim()];
        if (exit !== 0 && stderr.trim()) {
            parts.push(`stderr:\n${stderr.trim().split('\n').slice(-20).join('\n')}`);
        }
        if (exit === 0 && summary?.branch) {
            parts.push(`Review the diff: git -C "${summary.worktree}" diff ${summary.base_sha}..HEAD. ` +
                `Merge it yourself; the worker never merges or pushes.`);
            if (usedSnapshot) {
                parts.push(`The branch starts from a snapshot of your uncommitted work (${summary.base_sha}), ` +
                    `so bring over only the worker's commits: git cherry-pick ${summary.base_sha}..${summary.branch}`);
            }
        } else if (exit === 4) {
            parts.push(`The worker has questions (above). Answer them with start_opencode_job ` +
                `{ "name": "${name}", "dir": "${dir}", "reply": "<your answers>" }.`);
        } else if (exit === 9) {
            parts.push('The worker made no change.');
        }

        return {
            kind: 'opencode', ok: exit === 0, exit, name, mode, needs_input: exit === 4,
            status: summary?.status ?? null, branch: summary?.branch ?? null, worktree: summary?.worktree ?? null,
            base_sha: summary?.base_sha ?? null, commits: summary?.commits ?? [], run_dir: runDir ?? null,
            seconds: summary?.seconds ?? null, tokens: summary?.tokens ?? null, text: parts.join('\n\n'),
        };
    } finally {
        rmSync(briefDir, { recursive: true, force: true });
    }
}
