// The OpenCode worker must only ever reach WarriorGPT: never the user's own providers (an OpenCode Go or Zen
// login, an Anthropic or OpenAI key), whatever is in their OpenCode config, data folder or environment.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const RUNNER = resolve(here, '../warriorgpt-delegate.mjs');
const MOCK = pathToFileURL(join(here, 'mock-fetch.mjs')).href;
const FAKE = join(here, 'fake-opencode.mjs');
const GIT_ENV = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };
const API_BASE = 'https://warriorgpt.wayne.edu/api/v1';
const MODELS = ['local.qwen3.8-27b', 'local.gpt-oss-120b', 'local.gemma-4-31b', 'local.laguna-s-2.1'];
// Credentials for other providers, planted in the environment the runner is started with.
const CANARY_ENV = {
    ANTHROPIC_API_KEY: 'sk-canary-anthropic', OPENAI_API_KEY: 'sk-canary-openai', OPENCODE_API_KEY: 'sk-canary-zen',
    OPENROUTER_API_KEY: 'sk-canary-openrouter', GEMINI_API_KEY: 'sk-canary-gemini',
    GOOGLE_GENERATIVE_AI_API_KEY: 'sk-canary-google', AWS_ACCESS_KEY_ID: 'AKIACANARY',
    AWS_SECRET_ACCESS_KEY: 'canary-secret', AWS_SESSION_TOKEN: 'canary-token', AWS_BEARER_TOKEN_BEDROCK: 'canary-bedrock',
    GOOGLE_APPLICATION_CREDENTIALS: '/canary/creds.json',
    OPENCODE_CONFIG_CONTENT: '{"provider":{"opencode":{}}}',
};

let dir, home, repo, brief, userData;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'warriorgpt-seal-test-'));
    home = join(dir, 'home');
    mkdirSync(home);
    // The user's own OpenCode setup: an OpenCode Go provider and model, a plugin and an MCP server, and no
    // warriorgpt provider at all (someone who installed only this package).
    mkdirSync(join(dir, 'config', 'opencode'), { recursive: true });
    writeFileSync(join(dir, 'config', 'opencode', 'opencode.json'), JSON.stringify({
        model: 'opencode/big-pickle', small_model: 'opencode/gpt-5-nano', plugin: ['x'], mcp: { blender: {} },
        provider: { opencode: { options: { apiKey: 'sk-canary-config' } } },
    }));
    // ...and a logged-in OpenCode Go subscription in the user's data folder.
    userData = join(dir, 'userdata');
    mkdirSync(join(userData, 'opencode'), { recursive: true });
    writeFileSync(join(userData, 'opencode', 'auth.json'), JSON.stringify({ opencode: { type: 'api', key: 'sk-canary-go' } }));
    repo = join(dir, 'repo');
    mkdirSync(repo);
    const git = (...args) => execFileSync('git', args, { cwd: repo, env: { ...process.env, ...GIT_ENV } });
    git('init', '-q');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'calc.py'), 'def add(a, b):\n    return a + b\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    brief = join(dir, 'brief.md');
    writeFileSync(brief, 'Do the thing.\n');
});

function run(args, env = {}) {
    return spawnSync(process.execPath, ['--import', MOCK, RUNNER, ...args], {
        encoding: 'utf8',
        cwd: dir,
        env: { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: home,
            XDG_CONFIG_HOME: join(dir, 'config'), XDG_DATA_HOME: userData, XDG_STATE_HOME: join(dir, 'userstate'),
            XDG_CACHE_HOME: join(dir, 'usercache'), WARRIORGPT_API_KEY: 'test-key', CLAUDE_CODE_SESSION_ID: 'test',
            WARRIORGPT_OPENCODE: FAKE, FAKE_OC_LOG: join(dir, 'oc.json'), ...GIT_ENV, ...CANARY_ENV,
            FAKE_OC: 'done', FAKE_OC_COMMIT: '1', ...env },
    });
}

const stateDir = () => process.platform === 'win32' ? join(home, 'warriorgpt-mcp') : join(home, '.local/share/warriorgpt-mcp');
const ocLog = () => JSON.parse(readFileSync(join(dir, 'oc.json'), 'utf8'));
const after = (argv, flag) => argv[argv.indexOf(flag) + 1];
const norm = (p) => resolve(p).toLowerCase();
const inside = (p, root) => norm(p).startsWith(norm(root));

test('runs without a warriorgpt provider in the user OpenCode config', () => {
    const res = run(['--name', 's1', '--brief', brief, '--dir', repo]);
    assert.equal(res.status, 0, res.stdout + res.stderr);
});

test('the worker config holds WarriorGPT and nothing of the user', () => {
    assert.equal(run(['--name', 's2', '--brief', brief, '--dir', repo]).status, 0);
    const { config, argv } = ocLog();
    assert.deepEqual(Object.keys(config.provider), ['warriorgpt']);
    assert.deepEqual(config.enabled_providers, ['warriorgpt']);
    assert.equal(config.providers, undefined);
    assert.equal(config.model, 'warriorgpt/local.qwen3.8-27b');
    assert.equal(config.small_model, 'warriorgpt/local.qwen3.8-27b');
    assert.equal(config.share, 'disabled');
    assert.equal(config.autoupdate, false);
    for (const k of ['plugin', 'plugins', 'mcp']) assert.equal(config[k], undefined, k);
    assert.equal(after(argv, '-m'), 'warriorgpt/local.qwen3.8-27b');

    const wg = config.provider.warriorgpt;
    assert.equal(wg.npm, '@ai-sdk/openai-compatible');
    assert.equal(wg.options.baseURL, API_BASE);
    assert.equal(wg.options.apiKey, '{env:WARRIORGPT_API_KEY}');
    for (const m of MODELS) {
        assert.ok(wg.models[m], `model ${m}`);
        assert.equal(wg.models[m].tool_call, true, `${m} tool_call`);
        assert.ok(wg.models[m].limit.context > 0 && wg.models[m].limit.output > 0, `${m} limit`);
    }
    // No credential of any kind is written into the config itself.
    assert.doesNotMatch(JSON.stringify(config), /test-key|canary/);
});

test('the worker cannot see the user OpenCode folders or other providers credentials', () => {
    assert.equal(run(['--name', 's3', '--brief', brief, '--dir', repo]).status, 0);
    const { env } = ocLog();
    for (const k of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME']) {
        assert.ok(env[k], `${k} is set`);
        assert.ok(inside(env[k], stateDir()), `${k}=${env[k]} is under the package state folder`);
    }
    assert.ok(!inside(env.XDG_DATA_HOME, userData));
    assert.equal(existsSync(join(env.XDG_DATA_HOME, 'opencode', 'auth.json')), false, 'no OpenCode login in the worker data folder');
    for (const k of ['OPENCODE_DISABLE_PROJECT_CONFIG', 'OPENCODE_DISABLE_CLAUDE_CODE', 'OPENCODE_DISABLE_AUTOUPDATE',
        'OPENCODE_DISABLE_MODELS_FETCH']) assert.equal(env[k], '1', k);
    assert.equal(env.WARRIORGPT_API_KEY, 'test-key');
    for (const k of Object.keys(CANARY_ENV)) assert.equal(env[k], undefined, `${k} reaches the worker`);
    assert.doesNotMatch(JSON.stringify(env), /canary/i);
});

test('a non-WarriorGPT model is refused before anything runs', () => {
    for (const m of ['opencode/big-pickle', 'anthropic/claude-haiku-4-5', 'openai/gpt-5-nano', 'opencode-go/glm-5']) {
        const res = run(['--name', 's4', '--brief', brief, '--dir', repo, '--model', m]);
        assert.equal(res.status, 2, `${m}: ${res.stdout}${res.stderr}`);
        assert.match(res.stdout + res.stderr, /WarriorGPT/);
        assert.equal(existsSync(join(dir, 'oc.json')), false, `${m} started OpenCode`);
    }
    assert.equal(run(['--model', 'opencode/big-pickle', '--probe']).status, 2);
});

test('WarriorGPT models are accepted with or without the warriorgpt/ prefix', () => {
    assert.equal(run(['--name', 's5', '--brief', brief, '--dir', repo, '--model', 'warriorgpt/local.gpt-oss-120b']).status, 0);
    let { config, argv } = ocLog();
    assert.equal(after(argv, '-m'), 'warriorgpt/local.gpt-oss-120b');
    assert.equal(config.model, 'warriorgpt/local.gpt-oss-120b');
    assert.equal(config.small_model, 'warriorgpt/local.gpt-oss-120b');

    assert.equal(run(['--name', 's6', '--brief', brief, '--dir', repo, '--model', 'local.laguna-s-2.1']).status, 0);
    ({ config, argv } = ocLog());
    assert.equal(after(argv, '-m'), 'warriorgpt/local.laguna-s-2.1');
});

test('a WarriorGPT model the package does not know yet still gets a provider entry', () => {
    assert.equal(run(['--name', 's7', '--brief', brief, '--dir', repo, '--model', 'local.new-model-9b']).status, 0);
    const { config, argv } = ocLog();
    assert.equal(after(argv, '-m'), 'warriorgpt/local.new-model-9b');
    const m = config.provider.warriorgpt.models['local.new-model-9b'];
    assert.ok(m, 'entry for the new model');
    assert.equal(m.tool_call, true);
    assert.ok(m.limit.context > 0 && m.limit.output > 0);
});

test('the worker data folder is the same across runs, so --resume finds the session', () => {
    assert.equal(run(['--name', 's8', '--brief', brief, '--dir', repo]).status, 0);
    const first = ocLog().env.XDG_DATA_HOME;
    assert.equal(run(['--name', 's9', '--brief', brief, '--dir', repo]).status, 0);
    assert.equal(norm(ocLog().env.XDG_DATA_HOME), norm(first));
});
