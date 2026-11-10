#!/usr/bin/env node
// MCP server (stdio) exposing WarriorGPT's OpenAI-compatible chat API as a tool, so a Claude Code
// session can hand text generation to WarriorGPT without going through opencode.

import { createInterface } from 'node:readline';
import { DEFAULT_MODEL } from './common.mjs';
import { MODELS, runAsk } from './ask.mjs';

const TOOL = {
    name: 'ask_warriorgpt',
    description:
        'Send a prompt to a WarriorGPT model (Wayne State, free) and get its text reply. Give it everything it ' +
        'needs: use context_files to attach files, and output_file (one file) or files (several new or existing ' +
        'files, edited in place) to write the reply straight to disk, so the content never passes through Claude. ' +
        'With files, check runs a command after the edits (tests, a type check). If the first one-shot attempt ' +
        'misses, the model gets tools (read_file, edit, run_check, and run_node, which runs a JavaScript snippet ' +
        'with this Node and no shell) and works until the check passes or max_steps runs out. By default a ' +
        'tool-loop lane races the one-shot attempts from the start, each attempt checked in its own copy of ' +
        'the tree. verify adds a ' +
        'round of the model\'s own spec checks after the check passes. If the check never passes, every file is ' +
        'restored and the result says fallback: opencode, meaning hand the task to a full coding agent. ' +
        'With verify, structuredContent carries verified: true when the self-check finished, false when it ran out ' +
        'of steps; either way the files pass the check. ' +
        'This call blocks until it finishes; for checked or multi-attempt tasks, run the warriorgpt-ask ' +
        'CLI with Bash in the background instead. Jobs pass fastest with the acceptance tests written first and ' +
        'passed as check, and with a big change split into small tasks that each name their files and context_files. ' +
        'A "warning:" line in the result means the problem is probably not the model\'s code (the check tests the ' +
        'real tree instead of the copy, fails the same way whatever the edits, or the thinking budget ran out). ' +
        'Review the diff: a passing check is not a review.',
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
            check: {
                type: 'string',
                description: 'With files: a shell command run after the edits are written, such as the tests that ' +
                    'should pass. On failure the tool loop starts (or, with loop: false, the model retries with the ' +
                    'output); if it never passes, every listed file is restored. Runs locally like any command you run.',
            },
            cwd: { type: 'string', description: 'Directory to run check in. Default: the common folder of files.' },
            loop: { type: 'boolean', description: 'With check: after a missed first attempt, switch to the tool loop (default true). false retries whole replies instead (max_attempts).' },
            parallel: { type: 'integer', description: 'With check: one-shot attempts sent at once, each checked in its own copy of the tree, raced by the loop lane from the start; the first to pass wins and the rest are cancelled (default 1, max 6).' },
            loop_lane: { type: 'boolean', description: 'With check: a tool-loop lane races the one-shot attempts from the start, in its own copy of the tree (default true). false: the one-shot attempts go first, then the loop starts from their best.' },
            max_steps: { type: 'integer', description: 'With check: tool-loop steps (default 30, max 40). Raise it when a result says the loop used all its steps.' },
            verify: { type: 'boolean', description: 'With check: after it passes, the model tests the spec rules the check does not cover with its own node:assert snippets and fixes genuine failures (default false). If it cannot finish, its changes are undone.' },
            max_attempts: { type: 'integer', description: 'With check and loop: false: attempts before giving up (default 3, max 5).' },
            check_timeout_s: { type: 'integer', description: 'With check: seconds before a run is killed (default 300, max 3600). Slow suites (PHP, a full pytest run) may need more.' },
            temperature: { type: 'number', description: "Temperature for the first attempt. Default 0.6 for Qwen models (sent with Qwen's recommended top_p, top_k and presence penalty); the server's own for others." },
            retry_temperature_step: { type: 'number', description: 'With check: added to the temperature on each retry, capped at 0.8 (default 0.1; 0 keeps it flat).' },
            log_file: { type: 'string', description: 'Absolute path. Every reply and check output is appended there, for diagnosing a miss.' },
            max_tokens: { type: 'integer', description: 'Max output tokens for the first reply (default 16384).' },
            loop_max_tokens: { type: 'integer', description: 'Max output tokens per tool-loop or verify step (default 8192).' },
            think_budget: { type: 'integer', description: 'Edit tasks: once a reply has thought this many tokens with nothing written, it is cut off and the model is asked for the edits with its analysis so far, with the budget doubled on each retry up to 16384 (default 4096; 0 = no budget).' },
            loop_think_budget: { type: 'integer', description: 'The same for tool-loop and verify steps (default 1536).' },
            loop_thinking: { type: 'string', enum: ['auto', 'on', 'off'], description: 'Ask the server to skip thinking in loop steps: auto after a runaway (default), off always, on never.' },
        },
        required: ['prompt'],
    },
};

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
                const res = await runAsk(params.arguments || {});
                const content = [{ type: 'text', text: res.text }];
                // verified false: the check passes, but the self-check did not finish.
                if (res.ok && res.verified !== undefined) {
                    return send({ id, result: { content, structuredContent: { ok: true, verified: res.verified,
                        ...(res.fallback ? { fallback: res.fallback } : {}), attempts: res.attempts, ...(res.steps ? { steps: res.steps } : {}) } } });
                }
                if (res.ok) return send({ id, result: { content } });
                // No attempt passed the check: say so in a form a client can branch on.
                return send({ id, result: { content, isError: true,
                    structuredContent: { ok: false, fallback: res.fallback, attempts: res.attempts,
                        ...(res.steps ? { steps: res.steps } : {}) } } });
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
