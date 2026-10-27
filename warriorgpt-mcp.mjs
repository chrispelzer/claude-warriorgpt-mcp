#!/usr/bin/env node
// MCP server (stdio) exposing WarriorGPT's OpenAI-compatible chat API as a tool, so a Claude Code
// session can hand text generation to WarriorGPT without going through opencode.

import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

const API_URL = 'https://warriorgpt.wayne.edu/api/v1/chat/completions';
const DEFAULT_MODEL = process.env.WARRIORGPT_MODEL || 'local.qwen3.8-27b';
const MODELS = {
    'local.qwen3.8-27b': 'Qwen 3.8 27B, 262k context. Best general coder (default).',
    'local.gpt-oss-120b': 'GPT-OSS 120B, 131k context. Stronger reasoning, slower.',
    'local.laguna-s-2.1': 'Laguna S 2.1, 131k context.',
    'local.gemma-4-31b': 'Gemma 4 31B, 131k context.',
};
const KEY_NAME = 'warriorgpt-api-key';
const STATE_DIR = process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'warriorgpt-mcp')
    : join(homedir(), '.local/share/warriorgpt-mcp');
const SESSION = process.env.CLAUDE_CODE_SESSION_ID || 'unknown';

const TOOL = {
    name: 'ask_warriorgpt',
    description:
        'Send a prompt to a WarriorGPT model (Wayne State, free) and get its text reply. It cannot read the ' +
        'repo or run commands; give it everything it needs. Use context_files to attach files and output_file ' +
        'to write the reply straight to disk, so the content never passes through Claude. Review what it wrote.',
    inputSchema: {
        type: 'object',
        properties: {
            prompt: { type: 'string', description: 'The task or question.' },
            model: {
                type: 'string',
                description: `WarriorGPT model id. Default ${DEFAULT_MODEL}. Known models:\n` +
                    Object.entries(MODELS).map(([id, d]) => `- ${id}: ${d}`).join('\n'),
            },
            system: { type: 'string', description: 'Optional system prompt.' },
            context_files: {
                type: 'array',
                items: { type: 'string' },
                description: 'Absolute paths of files to include as context.',
            },
            output_file: {
                type: 'string',
                description: 'Absolute path. If set, the model is asked for only the file contents, which are ' +
                    'written here (overwriting), and the tool returns a short summary instead of the text.',
            },
            max_tokens: { type: 'integer', description: 'Max output tokens (default 32768).' },
        },
        required: ['prompt'],
    },
};

// Windows has no built-in CLI that reads a stored credential, so it relies on the env var alone.
const KEY_STORES = {
    darwin: { cmd: 'security', args: ['find-generic-password', '-a', process.env.USER, '-s', KEY_NAME, '-w'],
        hint: `or store ${KEY_NAME} in the keychain` },
    linux: { cmd: 'secret-tool', args: ['lookup', 'service', KEY_NAME],
        hint: `or store it with secret-tool under service ${KEY_NAME}` },
};

function apiKey() {
    if (process.env.WARRIORGPT_API_KEY) return process.env.WARRIORGPT_API_KEY;
    // Claude Code launched outside a login shell won't have the export from the shell config.
    const store = KEY_STORES[process.platform];
    if (!store) return '';
    try {
        return execFileSync(store.cmd, store.args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
        return '';
    }
}

// Models often wrap a whole file in one fence despite being told not to.
function unfence(text) {
    const m = text.trim().match(/^```[^\n]*\n([\s\S]*?)\n```$/);
    return m ? m[1] : text.trim();
}

async function askWarriorGPT(args) {
    const key = apiKey();
    if (!key) {
        const hint = KEY_STORES[process.platform]?.hint;
        throw new Error(`No WarriorGPT API key: set WARRIORGPT_API_KEY${hint ? ` ${hint}` : ''}.`);
    }

    const model = args.model || DEFAULT_MODEL;
    let user = args.prompt;
    for (const path of args.context_files || []) {
        const abs = resolve(path);
        user += `\n\nFile: ${abs}\n\`\`\`\n${readFileSync(abs, 'utf8')}\n\`\`\``;
    }
    const system = [
        args.system,
        args.output_file && 'Reply with only the complete contents of the requested file: no explanation, no markdown fences.',
    ].filter(Boolean).join('\n\n');
    const messages = [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: user }];

    const activeFile = join(STATE_DIR, `active-${SESSION}`);
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(activeFile, '');
    let data;
    try {
        const res = await fetch(API_URL, {
            method: 'POST',
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, messages, max_tokens: args.max_tokens || 32768 }),
            signal: AbortSignal.timeout(15 * 60 * 1000),
        });
        if (!res.ok) throw new Error(`WarriorGPT ${res.status}: ${(await res.text()).slice(0, 500)}`);
        data = await res.json();
    } finally {
        rmSync(activeFile, { force: true });
    }

    const usage = { in: data.usage?.prompt_tokens || 0, out: data.usage?.completion_tokens || 0 };
    appendFileSync(join(STATE_DIR, 'usage.jsonl'),
        JSON.stringify({ ts: new Date().toISOString(), session: SESSION, model, ...usage }) + '\n');

    const choice = data.choices?.[0];
    const text = choice?.message?.content ?? '';
    const stats = `${model}, ${usage.in} in / ${usage.out} out tokens`;
    if (choice?.finish_reason === 'length') {
        throw new Error(`Reply was cut off at max_tokens (${stats}); nothing written. Split the task or raise max_tokens.`);
    }
    if (!args.output_file) return `${text.trim()}\n\n(${stats})`;

    const out = resolve(args.output_file);
    const body = unfence(text) + '\n';
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, body);
    return `Wrote ${body.split('\n').length - 1} lines to ${out} (${stats}).`;
}

function send(msg) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
}

async function handle(req) {
    const { id, method, params } = req;
    switch (method) {
        case 'initialize':
            return send({ id, result: {
                protocolVersion: params?.protocolVersion || '2025-06-18',
                capabilities: { tools: {} },
                serverInfo: { name: 'warriorgpt', version: '1.0.0' },
            } });
        case 'ping':
            return send({ id, result: {} });
        case 'tools/list':
            return send({ id, result: { tools: [TOOL] } });
        case 'tools/call':
            if (params?.name !== TOOL.name) return send({ id, error: { code: -32602, message: `Unknown tool ${params?.name}` } });
            try {
                const text = await askWarriorGPT(params.arguments || {});
                return send({ id, result: { content: [{ type: 'text', text }] } });
            } catch (err) {
                return send({ id, result: { content: [{ type: 'text', text: err.message }], isError: true } });
            }
        default:
            // Notifications (no id) need no reply.
            if (id !== undefined) send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
}

createInterface({ input: process.stdin }).on('line', (line) => {
    if (!line.trim()) return;
    let req;
    try {
        req = JSON.parse(line);
    } catch {
        return send({ id: null, error: { code: -32700, message: 'Parse error' } });
    }
    handle(req);
});
