#!/usr/bin/env node
// MCP server (stdio) exposing WarriorGPT's OpenAI-compatible chat API as a tool, so a Claude Code
// session can hand text generation to WarriorGPT without going through opencode.

import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { API_BASE, DEFAULT_MODEL, STATE_DIR, SESSION, apiKey, missingKeyMessage } from './common.mjs';

const API_URL = `${API_BASE}/chat/completions`;
const MODELS = {
    'local.qwen3.8-27b': 'Qwen 3.8 27B, 262k context. Best general coder (default).',
    'local.gpt-oss-120b': 'GPT-OSS 120B, 131k context. Stronger reasoning, slower.',
    'local.laguna-s-2.1': 'Laguna S 2.1, 131k context.',
    'local.gemma-4-31b': 'Gemma 4 31B, 131k context.',
};

const TOOL = {
    name: 'ask_warriorgpt',
    description:
        'Send a prompt to a WarriorGPT model (Wayne State, free) and get its text reply. It cannot read the ' +
        'repo or run commands; give it everything it needs. Use context_files to attach files, and output_file ' +
        '(one file) or files (several new or existing files, edited in place) to write the reply straight to ' +
        'disk, so the content never passes through Claude. Review what it wrote.',
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
            files: {
                type: 'array',
                items: { type: 'string' },
                description: 'Absolute paths the model may create or change; existing ones are attached ' +
                    'automatically. It replies with a full body for new files and search/replace edits for ' +
                    'existing ones. Every block is checked first: if any fails, nothing is written. ' +
                    'Not with output_file.',
            },
            max_tokens: { type: 'integer', description: 'Max output tokens (default 32768).' },
        },
        required: ['prompt'],
    },
};

const FILES_FORMAT = `Reply with only file blocks and no other text. For each file you create or change:

=== FILE: <absolute path> ===
<body>
=== END FILE ===

For a new file, the body is the complete file contents. For an existing file, the body is one or more
edit blocks instead:

<<<<<<< SEARCH
lines copied exactly from the current file, enough of them to match only one place
=======
the lines that replace them
>>>>>>> REPLACE

Only write files from the allowed list, and leave out files that need no change.`;

// Models often wrap a whole file in one fence despite being told not to.
function unfence(text) {
    const m = text.trim().match(/^```[^\n]*\n([\s\S]*?)\n```$/);
    return m ? m[1] : text.trim();
}

function matchAllowed(path, allowed) {
    const abs = resolve(path);
    if (allowed.includes(abs)) return abs;
    // Models sometimes shorten the path; accept it if it names exactly one allowed file.
    const tail = '/' + path.replace(/\\/g, '/').replace(/^\.?\//, '');
    const hits = allowed.filter((a) => a.replace(/\\/g, '/').endsWith(tail));
    return hits.length === 1 ? hits[0] : null;
}

function applyEdits(content, body) {
    const errors = [];
    let edits = 0;
    for (const [, search, replace] of body.matchAll(/<<<<<<< SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n?>>>>>>> REPLACE/g)) {
        const count = content.split(search).length - 1;
        if (count !== 1) {
            errors.push(`edit ${edits + 1}: search text ${count ? `matches ${count} places` : 'not found'}`);
        } else {
            // An empty replacement deletes the lines, so drop the newline after them too.
            const at = content.indexOf(search);
            const end = at + search.length + (replace === '' && content[at + search.length] === '\n' ? 1 : 0);
            content = content.slice(0, at) + replace + content.slice(end);
        }
        edits++;
    }
    if (!edits) errors.push('no edit blocks found');
    return { content, edits, errors };
}

// Works out every write in memory first, so a bad block leaves all files untouched.
function writeFiles(text, allowed, stats) {
    const blocks = [...text.matchAll(/^=== FILE: (.+?) ===\n([\s\S]*?)\n?^=== END FILE ===$/gm)];
    if (!blocks.length) throw new Error(`Reply had no file blocks (${stats}); nothing written.`);

    const plan = new Map();
    const errors = [];
    for (const [, rawPath, body] of blocks) {
        const path = matchAllowed(rawPath.trim(), allowed);
        if (!path) {
            errors.push(`${rawPath.trim()}: not in files`);
            continue;
        }
        const prev = plan.get(path);
        const original = prev ? null : existsSync(path) ? readFileSync(path, 'utf8') : null;
        const crlf = prev ? prev.crlf : original?.includes('\r\n') ?? false;
        const current = prev ? prev.content : original?.replace(/\r\n/g, '\n') ?? null;
        if (body.includes('<<<<<<< SEARCH')) {
            if (current === null) {
                errors.push(`${path}: edit blocks for a file that does not exist`);
                continue;
            }
            const res = applyEdits(current, body);
            errors.push(...res.errors.map((e) => `${path}: ${e}`));
            plan.set(path, { content: res.content, crlf, created: prev?.created ?? false,
                edits: (prev?.edits ?? 0) + res.edits });
        } else {
            plan.set(path, { content: unfence(body).replace(/\n*$/, '\n'), crlf,
                created: prev ? prev.created : current === null, edits: prev?.edits ?? 0 });
        }
    }
    if (errors.length) throw new Error(`Nothing written (${stats}):\n- ${errors.join('\n- ')}`);

    const lines = [];
    for (const [path, f] of plan) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, f.crlf ? f.content.replace(/\n/g, '\r\n') : f.content);
        lines.push(f.created ? `created ${path} (${f.content.split('\n').length - 1} lines)`
            : f.edits ? `edited ${path} (${f.edits} edit${f.edits === 1 ? '' : 's'})` : `rewrote ${path}`);
    }
    const untouched = allowed.filter((a) => !plan.has(a));
    if (untouched.length) lines.push(`unchanged: ${untouched.join(', ')}`);
    return `${lines.join('\n')}\n(${stats})`;
}

async function askWarriorGPT(args) {
    const key = apiKey();
    if (!key) throw new Error(missingKeyMessage());

    if (args.files?.length && args.output_file) throw new Error('Pass files or output_file, not both.');
    const files = (args.files || []).map((p) => resolve(p));
    const model = args.model || DEFAULT_MODEL;
    let user = args.prompt;
    for (const path of args.context_files || []) {
        const abs = resolve(path);
        user += `\n\nFile: ${abs}\n\`\`\`\n${readFileSync(abs, 'utf8')}\n\`\`\``;
    }
    if (files.length) {
        user += `\n\nAllowed files:\n${files.map((f) => `- ${f}${existsSync(f) ? '' : ' (new)'}`).join('\n')}`;
        for (const f of files.filter((f) => existsSync(f))) {
            user += `\n\nFile: ${f}\n\`\`\`\n${readFileSync(f, 'utf8')}\n\`\`\``;
        }
    }
    const system = [
        args.system,
        args.output_file && 'Reply with only the complete contents of the requested file: no explanation, no markdown fences.',
        files.length && FILES_FORMAT,
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
    if (files.length) return writeFiles(text, files, stats);
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
