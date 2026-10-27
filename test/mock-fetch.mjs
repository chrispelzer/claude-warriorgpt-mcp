// Preloaded into the server under test: replaces fetch with a canned WarriorGPT reply.
import { readFileSync, writeFileSync } from 'node:fs';

globalThis.fetch = async (url, init) => {
    if (process.env.MOCK_REQUEST) writeFileSync(process.env.MOCK_REQUEST, init.body);
    return {
        ok: true,
        json: async () => ({
            usage: { prompt_tokens: 10, completion_tokens: 20 },
            choices: [{
                finish_reason: process.env.MOCK_FINISH || 'stop',
                message: { content: readFileSync(process.env.MOCK_REPLY, 'utf8') },
            }],
        }),
    };
};
