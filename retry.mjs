// When a WarriorGPT request is worth sending again, and how long to wait first. The gateway caps each API key at a
// few requests at once and answers the rest with 429 and Retry-After; a dropped connection or a stream the gateway
// marks as cut short is also worth another try. A quota 429 (Retry-After in days) is not.

export const DEFAULT_MAX_RETRIES = 5;
export const DEFAULT_RETRY_BASE_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
// A longer Retry-After than this is a quota, not a busy key: fail at once with the server's message.
export const MAX_RETRY_AFTER_MS = 60_000;
const NO_RETRY_CODES = new Set(['quota_exceeded', 'insufficient_quota']);

const envNumber = (name, fallback) => {
    const v = process.env[name];
    return v === undefined || v === '' || !(Number(v) >= 0) ? fallback : Number(v);
};
export const maxRetries = () => Math.floor(envNumber('WARRIORGPT_MAX_RETRIES', DEFAULT_MAX_RETRIES));
export const retryBaseMs = () => envNumber('WARRIORGPT_RETRY_BASE_MS', DEFAULT_RETRY_BASE_MS);

// Retry-After in seconds (fractions allowed) or as an HTTP date; null when absent or unreadable.
export function retryAfterMs(value, now = Date.now()) {
    if (value === null || value === undefined || String(value).trim() === '') return null;
    const s = String(value).trim();
    if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
    const at = Date.parse(s);
    return Number.isNaN(at) ? null : Math.max(0, at - now);
}

// Exponential backoff with jitter: half the step fixed, half random, so clients that collided spread out.
export function backoffMs(retry, base = retryBaseMs(), random = Math.random) {
    const step = Math.min(base * 2 ** (retry - 1), MAX_BACKOFF_MS);
    return Math.round(step / 2 + random() * step / 2);
}

// A fetch that failed before any reply came back, for a reason that tends to pass: a reset or refused connection, a
// timeout, a DNS blip. Certificate and TLS failures are not transient.
const TRANSIENT = /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|socket hang up|other side closed|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT|terminated/i;
const NOT_TRANSIENT = /CERT|SSL|TLS|self[- ]signed|unable to verify/i;
export function isTransientNetworkError(err) {
    if (!err || err.name === 'AbortError' || err.name === 'TimeoutError') return false;
    const parts = [err.code, err.message, err.cause?.code, err.cause?.message, err.cause?.cause?.code].filter(Boolean).join(' ');
    return TRANSIENT.test(parts) && !NOT_TRANSIENT.test(parts);
}

// The OpenAI-style error body: { error: { message, code } }, or the raw text when it is not JSON.
export function errorBody(text) {
    try {
        const e = JSON.parse(text)?.error;
        if (e && typeof e === 'object') return { message: String(e.message || text), code: e.code || e.type || '' };
        if (typeof e === 'string') return { message: e, code: '' };
    } catch { /* not JSON */ }
    return { message: text, code: '' };
}

// Whether a 429 is worth waiting out, and the server's own wait; quota denials and long waits are not.
export function rateLimitWait(code, retryAfter) {
    if (NO_RETRY_CODES.has(code)) return null;
    if (retryAfter !== null && retryAfter > MAX_RETRY_AFTER_MS) return null;
    return retryAfter ?? 0;
}

// Resolves after ms, or rejects with the signal's reason once it aborts.
export function sleep(ms, signal) {
    return new Promise((done, fail) => {
        if (signal?.aborted) return fail(signal.reason);
        const t = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            done();
        }, ms);
        const onAbort = () => {
            clearTimeout(t);
            fail(signal.reason);
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
