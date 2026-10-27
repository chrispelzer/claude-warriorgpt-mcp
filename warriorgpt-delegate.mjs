#!/usr/bin/env node
// Hands one bounded task to an OpenCode worker on a WarriorGPT model, waits, and collects evidence for the
// dispatcher to check. Never merges, pushes, or deletes anything.

import { parseArgs } from 'node:util';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import {
    readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, readdirSync, statSync, openSync, closeSync,
    cpSync, realpathSync,
} from 'node:fs';
import { join, dirname, basename, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { API_BASE, DEFAULT_MODEL, STATE_DIR, SESSION, apiKey, missingKeyMessage } from './common.mjs';

const DELEGATE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'delegate');
const EXCLUDED = new Set(['node_modules', '.git', 'vendor', '.claude', '.pnpm-store', '__pycache__']);

const USAGE = `Usage: warriorgpt-delegate --name <task> --brief <file> [options]

  --name <task>          task id: lower-case letters, digits, dashes
  --brief <file>         the brief; it must stand alone, the worker sees nothing else
  --model <id>           provider/model or a bare WarriorGPT id (default warriorgpt/${DEFAULT_MODEL})
  --mode write|read      write (default) changes files; read answers a question and changes nothing
  --dir <path>           project folder (default: current directory)
  --base <ref>           commit the worktree starts from (default HEAD)
  --timeout <minutes>    default 30
  --instructions <file>  extra instruction file for the worker (project context); repeatable
  --run-root <path>      where run folders go (default <state dir>/runs/<project>)
  --continue             follow-up on the same task: same worktree and run folder, fresh session
  --resume               with --continue: resume the previous OpenCode session (to answer NEEDS_INPUT);
                         the brief then holds just the answers
  --probe                only check that the model answers

Exit codes: 0 done; 1 failed; 2 usage; 3 model unreachable; 4 NEEDS_INPUT; 8 timed out;
9 write mode, no change made; 10 STATUS PARTIAL/BLOCKED or missing.`;

function fail(code, why) {
    console.log(`warriorgpt-delegate: ${why}`);
    process.exit(code);
}

function git(cwd, ...args) {
    try {
        return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trimEnd();
    } catch {
        return null;
    }
}

const lines = (s) => (s ? s.split('\n').filter(Boolean) : []);

let opts;
try {
    opts = parseArgs({
        options: {
            name: { type: 'string' }, brief: { type: 'string' }, model: { type: 'string' },
            mode: { type: 'string', default: 'write' }, dir: { type: 'string', default: process.cwd() },
            base: { type: 'string', default: 'HEAD' }, timeout: { type: 'string', default: '30' },
            instructions: { type: 'string', multiple: true, default: [] }, 'run-root': { type: 'string' },
            continue: { type: 'boolean' }, resume: { type: 'boolean' }, probe: { type: 'boolean' },
            help: { type: 'boolean', short: 'h' },
        },
    }).values;
} catch (err) {
    fail(2, `${err.message}\n\n${USAGE}`);
}
if (opts.help) {
    console.log(USAGE);
    process.exit(0);
}

const model = opts.model?.includes('/') ? opts.model : `warriorgpt/${opts.model || DEFAULT_MODEL}`;
const [provider, modelId] = [model.slice(0, model.indexOf('/')), model.slice(model.indexOf('/') + 1)];
const key = apiKey();
if (provider === 'warriorgpt' && !key) fail(1, missingKeyMessage());

// --- probe: one tiny chat request ---------------------------------------------------------------------------
if (provider === 'warriorgpt') {
    let probeErr = null;
    try {
        const res = await fetch(`${API_BASE}/chat/completions`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: modelId, max_tokens: 16, messages: [{ role: 'user', content: 'Reply with OK.' }] }),
            signal: AbortSignal.timeout(60 * 1000),
        });
        if (!res.ok) probeErr = `${res.status} ${(await res.text()).slice(0, 200)}`;
    } catch (err) {
        probeErr = err.message;
    }
    if (probeErr) fail(3, `${model} does not answer: ${probeErr}. Use another model.`);
}
if (opts.probe) fail(0, `${model} answers`);

// --- arguments ----------------------------------------------------------------------------------------------
const { name, mode } = opts;
if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(name || '')) fail(2, '--name must be lower-case letters, digits and dashes');
if (!['write', 'read'].includes(mode)) fail(2, '--mode must be write or read');
if (!opts.brief || !existsSync(opts.brief)) fail(2, '--brief is required and must exist');
if (!existsSync(opts.dir)) fail(2, `--dir ${opts.dir} does not exist`);
const timeoutMin = Number(opts.timeout);
if (!(timeoutMin > 0)) fail(2, '--timeout must be a positive number of minutes');
const instructions = opts.instructions.map((f) => {
    if (!existsSync(f)) fail(2, `instruction file ${f} does not exist`);
    return resolve(f);
});
// .native expands Windows 8.3 short names, so dir and gitTop compare as the same path.
const dir = realpathSync.native(opts.dir);

const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
const globalCfgPath = join(configHome, 'opencode', 'opencode.json');
let globalCfg;
try {
    globalCfg = JSON.parse(readFileSync(globalCfgPath, 'utf8'));
} catch (err) {
    fail(1, `cannot read the OpenCode config at ${globalCfgPath}: ${err.message}`);
}
// OpenCode 2 calls the block "providers", older versions "provider".
const providerKey = globalCfg.providers ? 'providers' : 'provider';
if (!globalCfg[providerKey]?.[provider]) fail(1, `provider ${provider} is not in ${globalCfgPath}`);

const top = git(dir, 'rev-parse', '--show-toplevel');
const gitTop = top && realpathSync.native(top);
const slug = basename(gitTop || dir);
const runDir = join(opts['run-root'] || join(STATE_DIR, 'runs', slug), name);
mkdirSync(runDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
let prev = null;
if (opts.continue) {
    try {
        prev = JSON.parse(readFileSync(join(runDir, 'summary.json'), 'utf8'));
    } catch {
        fail(2, `--continue: no earlier run of ${name} in ${runDir}`);
    }
    if (prev.mode !== mode) fail(2, `--continue: the earlier run was mode ${prev.mode}; pass --mode ${prev.mode}`);
}
if (opts.resume && !prev?.session) fail(2, '--resume needs --continue and an earlier run with a session id');

// --- where the worker runs ----------------------------------------------------------------------------------
let branch = null, baseSha = null, worktree = null, workDir = dir;
if (mode === 'write' && gitTop) {
    branch = `dl/${name}`;
    worktree = join(STATE_DIR, 'worktrees', `${slug}-${name}`);
    if (opts.continue) {
        if (!existsSync(worktree)) fail(2, `--continue: no worktree at ${worktree}`);
        baseSha = prev.base_sha;
    } else {
        if (existsSync(worktree)) fail(2, `worktree ${worktree} already exists; use --continue or another --name`);
        baseSha = git(gitTop, 'rev-parse', '--verify', `${opts.base}^{commit}`);
        if (!baseSha) fail(2, `--base ${opts.base} is not a commit in ${gitTop}`);
        if (git(gitTop, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`)) {
            fail(2, `branch ${branch} already exists; use --continue or another --name`);
        }
        mkdirSync(dirname(worktree), { recursive: true });
        const add = spawnSync('git', ['-C', gitTop, 'worktree', 'add', '--quiet', '-b', branch, worktree, baseSha],
            { encoding: 'utf8' });
        if (add.status !== 0) fail(1, `git worktree add failed: ${add.stderr.trim()}`);
    }
    // Keep the same subfolder when --dir was inside the repo.
    workDir = join(worktree, relative(gitTop, dir));
} else if (gitTop) {
    baseSha = git(gitTop, 'rev-parse', 'HEAD');
}

function snapshot(root) {
    const map = new Map();
    const walk = (d) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
            const p = join(d, e.name);
            if (e.isDirectory()) {
                if (!EXCLUDED.has(e.name)) walk(p);
            } else {
                const s = statSync(p, { throwIfNoEntry: false });
                if (s) map.set(relative(root, p), `${s.size}:${s.mtimeMs}`);
            }
        }
    };
    walk(root);
    return map;
}
const before = worktree ? null : snapshot(workDir);

// --- brief --------------------------------------------------------------------------------------------------
let header;
if (opts.resume) {
    header = `The lead's reply to your last message follows. Continue the same task (${name}) with it, and end with the HANDOFF block.\n`;
} else {
    header = `Task: ${name}\nMode: ${mode}${mode === 'read' ? ' (do not change any file; your final message is the deliverable)' : ''}\n` +
        `Working directory: ${workDir}\n` +
        (branch ? `Branch: ${branch} (from ${baseSha}); commit your work here\n` : '');
    if (opts.continue) {
        const done = worktree ? git(worktree, 'log', '--oneline', `${baseSha}..HEAD`) : '';
        header += `This is a follow-up on earlier work in this directory.${done ? ` Commits so far:\n${done}` : ''}\n`;
    }
}
const briefPath = join(runDir, `brief_${stamp}.md`);
writeFileSync(briefPath, `${header}\n${readFileSync(opts.brief, 'utf8')}`);

// --- isolated OpenCode config: the user's providers, no plugins or MCP servers, only our instructions ---------
const cfgHome = join(STATE_DIR, 'opencode-config', `${slug}-${name}`);
mkdirSync(join(cfgHome, 'opencode'), { recursive: true });
// Moving XDG_CONFIG_HOME would also hide the user's git identity from the worker's commits.
if (existsSync(join(configHome, 'git'))) cpSync(join(configHome, 'git'), join(cfgHome, 'git'), { recursive: true });
const cfgFile = join(cfgHome, 'opencode', 'opencode.json');
writeFileSync(cfgFile, JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    [providerKey]: globalCfg[providerKey],
    instructions: [join(DELEGATE_DIR, 'WORKER_RULES.md'), ...instructions].map((p) => p.replaceAll('\\', '/')),
}, null, 2));
const env = {
    ...process.env,
    // OpenCode takes its directory from PWD, which spawn's cwd does not update.
    PWD: workDir,
    XDG_CONFIG_HOME: cfgHome,
    OPENCODE_CONFIG: cfgFile,
    OPENCODE_CONFIG_DIR: join(DELEGATE_DIR, 'opencode'),
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    ...(key && { WARRIORGPT_API_KEY: key }),
};
delete env.OPENCODE_CONFIG_CONTENT;

const agent = mode === 'read' ? 'delegate-reader' : 'delegate-worker';
// --standalone: the background service would ignore this process's config.
const runArgs = ['run', '--standalone', '--agent', agent, '-m', model, '--format', 'json', '--title', `dl:${slug}-${name}`,
    ...(opts.resume ? ['-s', prev.session] : [])];
const eventsPath = join(runDir, `events_${stamp}.jsonl`);
const stderrPath = join(runDir, `stderr_${stamp}.log`);
console.log(`warriorgpt-delegate: ${name} -> ${model} (${mode}) in ${workDir}, timeout ${timeoutMin} min; run folder ${runDir}`);

function launch() {
    const bin = process.env.WARRIORGPT_OPENCODE || 'opencode';
    const [cmd, args] = /\.[cm]?js$/.test(bin) ? [process.execPath, [bin, ...runArgs]] : [bin, runArgs];
    const fds = [openSync(briefPath, 'r'), openSync(eventsPath, 'w'), openSync(stderrPath, 'w')];
    const win = process.platform === 'win32';
    // npm installs opencode as a .cmd on Windows, which only starts through a shell.
    const child = spawn(cmd, win && cmd === bin ? args.map((a) => `"${a}"`) : args,
        { cwd: workDir, env, stdio: fds, detached: !win, shell: win && cmd === bin });
    fds.forEach(closeSync);
    return new Promise((done) => {
        const timer = setTimeout(() => {
            timedOut = true;
            if (win) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
            else try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        }, timeoutMin * 60 * 1000);
        child.on('error', (err) => {
            clearTimeout(timer);
            appendFileSync(stderrPath, `${err.message}\n`);
            done(127);
        });
        child.on('exit', (code) => {
            clearTimeout(timer);
            done(code ?? 1);
        });
    });
}

// Parallel OpenCode runs share one database; a run that dies early on its lock is safe to relaunch.
let timedOut = false, ocExit, t0;
for (let attempt = 1; attempt <= 3; attempt++) {
    t0 = Date.now();
    ocExit = await launch();
    const early = !timedOut && Date.now() - t0 < 60 * 1000;
    const locked = early && /database is locked/.test(readFileSync(stderrPath, 'utf8') + readFileSync(eventsPath, 'utf8'));
    if (!locked || attempt === 3) break;
    console.log(`warriorgpt-delegate: attempt ${attempt} hit 'database is locked'; relaunching`);
    await sleep(10_000 + Math.random() * 15_000);
}
const seconds = Math.round((Date.now() - t0) / 1000);

// --- evidence -----------------------------------------------------------------------------------------------
let session = null, toolCalls = 0, toolErrors = 0;
const texts = [], errors = [], tokens = { in: 0, out: 0 };
for (const line of readFileSync(eventsPath, 'utf8').split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    let e;
    try {
        e = JSON.parse(line);
    } catch {
        continue;
    }
    session ||= e.sessionID;
    const part = e.part || {};
    if (part.type === 'text' && part.text) texts.push(part.text);
    if (part.type === 'tool') {
        toolCalls++;
        if (part.state?.status === 'error') toolErrors++;
    }
    if (part.type === 'step-finish') {
        tokens.in += part.tokens?.input || 0;
        tokens.out += (part.tokens?.output || 0) + (part.tokens?.reasoning || 0);
    }
    if (e.type === 'error') errors.push(JSON.stringify(e));
}
if (opts.resume) session ||= prev.session;
const final = texts.at(-1)?.trim() || '';
const handoff = texts.findLast((t) => t.includes('HANDOFF')) || final;
const status = handoff.match(/STATUS:\s*\**\s*(DONE|PARTIAL|BLOCKED|NEEDS_INPUT)/)?.[1] || null;
const stderrTail = readFileSync(stderrPath, 'utf8').trim().split('\n').slice(-15).join('\n');

let commits = [], diffStat = '', uncommitted = [], deletedLines = 0, changed = [];
if (worktree) {
    commits = lines(git(worktree, 'log', '--oneline', `${baseSha}..HEAD`));
    diffStat = git(worktree, 'diff', '--stat', `${baseSha}..HEAD`) || '';
    uncommitted = lines(git(worktree, 'status', '--short'));
    deletedLines = lines(git(worktree, 'diff', `${baseSha}..HEAD`)).filter((l) => /^-(?!--)/.test(l)).length;
    changed = lines(git(worktree, 'diff', '--name-only', `${baseSha}..HEAD`));
} else {
    const after = snapshot(workDir);
    for (const [k, v] of after) {
        if (!before.has(k)) changed.push(`added    ${k}`);
        else if (before.get(k) !== v) changed.push(`modified ${k}`);
    }
    for (const k of before.keys()) if (!after.has(k)) changed.push(`DELETED  ${k}`);
    changed.sort();
}

let code;
if (timedOut) code = 8;
else if (ocExit !== 0 || errors.length || !final) code = 1;
else if (status === 'NEEDS_INPUT') code = 4;
else if (mode === 'write' && (worktree ? commits.length === 0 : changed.length === 0)) code = 9;
else if (mode === 'read' && !status) code = 0; // an answer without the HANDOFF block is still an answer
else if (status !== 'DONE') code = 10;
else code = 0;

mkdirSync(STATE_DIR, { recursive: true });
appendFileSync(join(STATE_DIR, 'usage.jsonl'), JSON.stringify({
    ts: new Date().toISOString(), session: SESSION, model: modelId, ...tokens, via: 'opencode',
}) + '\n');

writeFileSync(join(runDir, 'summary.json'), JSON.stringify({
    name, model, mode, dir, work_dir: workDir, branch, worktree, base_sha: baseSha, session,
    exit: code, opencode_exit: ocExit, timed_out: timedOut, seconds, status, tokens,
    commits, uncommitted, changed, deleted_lines: deletedLines, tool_calls: toolCalls, tool_errors: toolErrors,
    errors, events: eventsPath,
}, null, 2));

const sections = [
    `# Delegated task ${name}`,
    `- Model \`${model}\`, mode ${mode}, work dir \`${workDir}\`${branch ? `, branch \`${branch}\` from \`${baseSha}\`` : ''}\n` +
    `- Exit ${code} (opencode ${ocExit}${timedOut ? ', TIMED OUT' : ''}), ${seconds} s, ${toolCalls} tool calls ` +
    `(${toolErrors} failed), ${tokens.in} in / ${tokens.out} out tokens, STATUS ${status || 'missing'}`,
    commits.length && `## Commits\n${commits.join('\n')}\n\n## Diff stat\n${diffStat}\n\nDeleted lines: ${deletedLines}`,
    uncommitted.length && `## Uncommitted\n${uncommitted.join('\n')}`,
    !worktree && changed.length && `## Files changed\n${changed.join('\n')}`,
    errors.length && `## Errors\n${errors.join('\n')}`,
    code !== 0 && stderrTail && `## stderr (tail)\n${stderrTail}`,
    `## Worker's final message\n${handoff || '(none)'}`,
].filter(Boolean);
const report = sections.join('\n\n') + '\n';
writeFileSync(join(runDir, 'report.md'), report);
console.log(report);
process.exit(code);
