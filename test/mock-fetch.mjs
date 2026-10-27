// Preloaded into the server under test: replaces fetch with a canned WarriorGPT reply.
import { readFileSync, writeFileSync } from 'node:fs';

globalThis.fetch = async (url, init) => {
    if (process.env.MOCK_REQUEST) writeFileSync(process.env.MOCK_REQUEST, init.body);
    const status = Number(process.env.MOCK_STATUS || 200);
    return {
        ok: status < 400,
        status,
        text: async () => 'mock error',
        json: async () => ({
            usage: { prompt_tokens: 10, completion_tokens: 20 },
            choices: [{
                finish_reason: process.env.MOCK_FINISH || 'stop',
                message: { content: readFileSync(process.env.MOCK_REPLY, 'utf8') },
            }],
        }),
    };
};
