// Preloaded into the server under test: replaces fetch with a canned WarriorGPT reply.
// MOCK_REPLIES (a JSON array file) answers each request with the next reply, repeating the last;
// MOCK_REQUEST keeps the first request body; MOCK_REQUEST_LOG gets every body as one JSON line.
// MOCK_FINISH_LIST (a JSON array) gives each request's finish_reason in turn, repeating the last.
// A reply may be an object {content, tool_calls: [{name, arguments}]} to answer with tool calls
// (finish_reason tool_calls unless MOCK_FINISH_LIST says otherwise); streamed as tool-call deltas.
// An object reply may also set finish, out (completion tokens), reasoning (reasoning tokens), and
// reasoning_text (streamed as reasoning deltas before any content).
// MOCK_ERROR_BODY is the body of a MOCK_STATUS error reply (default "mock error").
// MOCK_REJECT_KWARGS answers any request carrying chat_template_kwargs with a 400, as a strict server would.
// MOCK_ROUTES (a JSON file {"substring": [replies]}) answers a request whose body contains the substring from
// that list instead (each route keeps its own place, repeating its last reply). delay_ms on an object reply
// holds the streamed body back that long, and honours the request's abort signal.
// MOCK_UNREACHABLE makes fetch throw, as a network failure does. MOCK_STREAM answers as an SSE stream;
// MOCK_NO_FINISH ends that stream after the content, with no finish reason, as a dropped connection does.
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';

let calls = 0;
let requestsSeen = 0;
const routeCalls = {};

// Windows briefly locks freshly created files (antivirus); racing lanes fire their requests together.
const fsRetry = (fn) => {
    for (let n = 0; ; n++) {
        try { return fn(); }
        catch (err) {
            if (n >= 4 || (err.code !== 'EBUSY' && err.code !== 'EPERM')) throw err;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (n + 1));
        }
    }
};

function routed(body) {
    if (!process.env.MOCK_ROUTES) return undefined;
    const routes = JSON.parse(readFileSync(process.env.MOCK_ROUTES, 'utf8'));
    for (const [key, list] of Object.entries(routes)) {
        if (!body.includes(key)) continue;
        const n = routeCalls[key] = (routeCalls[key] ?? -1) + 1;
        return list[Math.min(n, list.length - 1)];
    }
    return undefined;
}

function finishFor(n) {
    if (!process.env.MOCK_FINISH_LIST) return process.env.MOCK_FINISH || 'stop';
    const list = JSON.parse(process.env.MOCK_FINISH_LIST);
    return list[Math.min(n, list.length - 1)];
}

function asObject(reply) {
    if (typeof reply === 'string') return { content: reply, tool_calls: [] };
    const calls = (reply.tool_calls || []).map((c, i) => ({ id: `call_${i}`, name: c.name,
        arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments) }));
    return { content: reply.content || '', tool_calls: calls, finish: reply.finish, out: reply.out, reasoning: reply.reasoning,
        reasoning_text: reply.reasoning_text || '', delay_ms: reply.delay_ms || 0 };
}

function finishOf(n, reply) {
    if (reply.finish) return reply.finish;
    if (process.env.MOCK_FINISH_LIST || process.env.MOCK_FINISH) return finishFor(n);
    return reply.tool_calls.length ? 'tool_calls' : 'stop';
}

function usageOf(reply) {
    return { prompt_tokens: 10, completion_tokens: reply.out ?? 20,
        ...(reply.reasoning !== undefined ? { completion_tokens_details: { reasoning_tokens: reply.reasoning } } : {}) };
}

function replyFor(n) {
    if (!process.env.MOCK_REPLIES) return readFileSync(process.env.MOCK_REPLY, 'utf8');
    const replies = JSON.parse(readFileSync(process.env.MOCK_REPLIES, 'utf8'));
    return replies[Math.min(n, replies.length - 1)];
}

globalThis.fetch = async (url, init) => {
    if (process.env.MOCK_REQUEST) {
        // The first request keeps its body (routed requests do not advance `calls`, so count separately); a
        // deleted file is recreated, as before.
        if (requestsSeen++ === 0 || !existsSync(process.env.MOCK_REQUEST)) fsRetry(() => writeFileSync(process.env.MOCK_REQUEST, init.body));
        if (process.env.MOCK_REQUEST_LOG) fsRetry(() => appendFileSync(process.env.MOCK_REQUEST_LOG, init.body + '\n'));
    }
    if (process.env.MOCK_UNREACHABLE) throw new TypeError('fetch failed');
    if (process.env.MOCK_REJECT_KWARGS && JSON.parse(init.body).chat_template_kwargs) {
        return { ok: false, status: 400, text: async () => '{"error":"unknown field: chat_template_kwargs"}' };
    }
    const status = Number(process.env.MOCK_STATUS || 200);
    const route = routed(init.body);
    const n = route === undefined ? calls++ : -1;
    const pick = (i) => (route === undefined ? replyFor(i) : route);
    if (process.env.MOCK_STREAM && status < 400) {
        const reply = asObject(pick(n));
        const text = reply.content;
        const half = Math.ceil(text.length / 2);
        const deltas = reply.reasoning_text ? [{ reasoning: reply.reasoning_text }] : [];
        if (text) deltas.push({ content: text.slice(0, half) }, { content: text.slice(half) });
        reply.tool_calls.forEach((c, index) => {
            // As vLLM sends them: id and name first, then the arguments in fragments.
            deltas.push({ tool_calls: [{ index, id: c.id, type: 'function', function: { name: c.name, arguments: '' } }] });
            const cut = Math.ceil(c.arguments.length / 2);
            deltas.push({ tool_calls: [{ index, function: { arguments: c.arguments.slice(0, cut) } }] });
            deltas.push({ tool_calls: [{ index, function: { arguments: c.arguments.slice(cut) } }] });
        });
        const sse = deltas.map((d) => `data: ${JSON.stringify({ choices: [{ delta: d }] })}\n\n`).join('')
            + (process.env.MOCK_NO_FINISH ? '' : `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishOf(n, reply) }] })}\n\n`
            + `data: ${JSON.stringify({ choices: [], usage: usageOf(reply) })}\n\ndata: [DONE]\n\n`);
        const enc = new TextEncoder();
        // Reasoning comes first and on its own, as it does live, so a thinking budget can cut the stream there.
        const lead = reply.reasoning_text ? sse.slice(0, sse.indexOf('\n\n') + 2) : '';
        const bytes = enc.encode(sse.slice(lead.length));
        const cut = Math.floor(bytes.length / 3); // split mid-line to exercise buffering
        const parts = [...(lead ? [enc.encode(lead)] : []), bytes.slice(0, cut), bytes.slice(cut)];
        const signal = init.signal;
        const body = !reply.delay_ms ? parts : (async function* () {
            yield parts[0];
            await new Promise((done, fail) => {
                const t = setTimeout(done, reply.delay_ms);
                signal?.addEventListener('abort', () => { clearTimeout(t); fail(new DOMException('aborted', 'AbortError')); }, { once: true });
            });
            for (const p of parts.slice(1)) yield p;
        })();
        return { ok: true, status, headers: { get: () => 'text/event-stream' }, body };
    }
    return {
        ok: status < 400,
        status,
        text: async () => process.env.MOCK_ERROR_BODY || 'mock error',
        // Read lazily: some callers (the delegate probe) never set a reply and never read the body.
        json: async () => { const reply = asObject(pick(n)); return {
            usage: usageOf(reply),
            choices: [{
                finish_reason: finishOf(n, reply),
                message: { content: reply.content, ...(reply.tool_calls.length ? { tool_calls: reply.tool_calls.map((c) =>
                    ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) } : {}) },
            }],
        }; },
    };
};
