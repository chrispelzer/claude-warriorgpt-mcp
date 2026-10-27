// Shared by the MCP server and the OpenCode runner.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

export const API_BASE = 'https://warriorgpt.wayne.edu/api/v1';
export const DEFAULT_MODEL = process.env.WARRIORGPT_MODEL || 'local.qwen3.8-27b';
export const STATE_DIR = process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'warriorgpt-mcp')
    : join(homedir(), '.local/share/warriorgpt-mcp');
export const SESSION = process.env.CLAUDE_CODE_SESSION_ID || 'unknown';

const KEY_NAME = 'warriorgpt-api-key';
// Windows has no built-in CLI that reads a stored credential, so it relies on the env var alone.
const KEY_STORES = {
    darwin: { cmd: 'security', args: ['find-generic-password', '-a', process.env.USER, '-s', KEY_NAME, '-w'],
        hint: `or store ${KEY_NAME} in the keychain` },
    linux: { cmd: 'secret-tool', args: ['lookup', 'service', KEY_NAME],
        hint: `or store it with secret-tool under service ${KEY_NAME}` },
};

export function apiKey() {
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

export function missingKeyMessage() {
    const hint = KEY_STORES[process.platform]?.hint;
    return `No WarriorGPT API key: set WARRIORGPT_API_KEY${hint ? ` ${hint}` : ''}.`;
}
