// File blocks and search/replace edits: parsing a reply, finding each search text (exactly, then with the
// forgiving matchers below), and working out every write before any file is touched.

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, rmSync, statSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// Models often wrap a whole file in one fence despite being told not to.
export function unfence(text) {
    const m = text.trim().match(/^```[^\n]*\n([\s\S]*?)\n```$/);
    return m ? m[1] : text.trim();
}

export function matchAllowed(path, allowed) {
    const abs = resolve(path);
    if (allowed.includes(abs)) return abs;
    // Models sometimes shorten the path; accept it if it names exactly one allowed file.
    const tail = '/' + path.replace(/\\/g, '/').replace(/^\.?\//, '');
    const hits = allowed.filter((a) => a.replace(/\\/g, '/').endsWith(tail));
    return hits.length === 1 ? hits[0] : null;
}

const HEADER = /^=== FILE: (.+?) ===[ \t]*$/gm;
const END = /^=== END FILE ===[ \t]*$/m;

// A block ends at its END FILE line, the next FILE header, or the end of the reply: models sometimes drop the
// last end marker, and the edits above it are still good.
export function parseBlocks(text) {
    const headers = [...text.matchAll(HEADER)];
    return headers.map((h, i) => {
        const start = h.index + h[0].length + 1;
        const stop = i + 1 < headers.length ? headers[i + 1].index : text.length;
        let body = text.slice(Math.min(start, stop), stop);
        const end = body.match(END);
        if (end) body = body.slice(0, end.index);
        return [h[1].trim(), body.replace(/\n$/, '')];
    });
}

const lead = (line) => line.match(/^[ \t]*/)[0];
const LINE_MATCHERS = [
    // Same lines, ignoring leading and trailing whitespace on each.
    ['line-trimmed', (line) => line.trim()],
    // Same tokens: every run of whitespace counts as one space.
    ['whitespace-normalized', (line) => line.trim().replace(/\s+/g, ' ')],
];

// Same block after removing each side's common indentation (a search copied at the wrong depth).
function dedent(lines) {
    const widths = lines.filter((l) => l.trim()).map((l) => lead(l).length);
    const n = widths.length ? Math.min(...widths) : 0;
    return lines.map((l) => (l.trim() ? l.slice(n) : '').replace(/\s+$/, ''));
}

function trimBlankEnds(lines) {
    let a = 0;
    let b = lines.length;
    while (a < b && !lines[a].trim()) a++;
    while (b > a && !lines[b - 1].trim()) b--;
    return lines.slice(a, b);
}

function windows(contentLines, searchLines, same) {
    const hits = [];
    for (let i = 0; i + searchLines.length <= contentLines.length; i++) {
        if (same(contentLines.slice(i, i + searchLines.length), searchLines)) hits.push(i);
    }
    return hits;
}

export function findMatch(content, search) {
    if (search === '') return { error: 'search text is empty' };
    const exact = content.split(search).length - 1;
    if (exact === 1) {
        const start = content.indexOf(search);
        return { start, end: start + search.length, how: 'exact' };
    }
    if (exact > 1) return { error: `search text matches ${exact} places` };

    const contentLines = content.split('\n');
    const searchLines = trimBlankEnds(search.split('\n'));
    if (!searchLines.length) return { error: 'search text not found' };
    const n = searchLines.length;
    // Strictest first, so a looser comparison only runs when a stricter one found nothing.
    const comparisons = [
        ['indentation-flexible', (win, s) => dedent(win).join('\n') === dedent(s).join('\n')],
        ...LINE_MATCHERS.map(([how, norm]) => [how, (win, s) => win.every((l, i) => norm(l) === norm(s[i]))]),
    ];
    for (const [how, same] of comparisons) {
        const hits = windows(contentLines, searchLines, same);
        if (hits.length > 1) return { error: `search text matches ${hits.length} places (${how})` };
        if (hits.length === 1) {
            const first = hits[0];
            const start = contentLines.slice(0, first).reduce((s, l) => s + l.length + 1, 0);
            const end = start + contentLines.slice(first, first + n).join('\n').length;
            // Re-indent the replacement by the same shift the search was off by.
            const was = lead(searchLines.find((l) => l.trim()) || '');
            const is = lead(contentLines.slice(first, first + n).find((l) => l.trim()) || '');
            return { start, end, how, indent: was === is ? null : { was, is } };
        }
    }
    const firstLine = searchLines.find((l) => l.trim()).trim();
    const near = contentLines.map((l, i) => (l.trim() === firstLine ? i + 1 : 0)).filter(Boolean).slice(0, 3);
    return { error: `search text not found${near.length ? ` (its first line is at line ${near.join(', ')}, but the lines after it differ)` : ''}` };
}

function reindent(text, { was, is }) {
    return text.split('\n').map((l) => {
        if (!l.trim()) return l;
        if (was && l.startsWith(was)) return is + l.slice(was.length);
        return was ? l : is + l;
    }).join('\n');
}

export function replaceOnce(content, search, replace) {
    const m = findMatch(content, search);
    if (m.error) return m;
    const text = m.indent ? reindent(replace, m.indent) : replace;
    // An empty replacement deletes the lines, so drop the newline after them too.
    const end = m.end + (replace === '' && content[m.end] === '\n' ? 1 : 0);
    return { content: content.slice(0, m.start) + text + content.slice(end), how: m.how, start: m.start };
}

export function applyEdits(content, body) {
    const errors = [];
    const fuzzy = [];
    let edits = 0;
    for (const [, search, replace] of body.matchAll(/<<<<<<< SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n?>>>>>>> REPLACE/g)) {
        const res = replaceOnce(content, search, replace);
        if (res.error) errors.push(`edit ${edits + 1}: ${res.error}`);
        else {
            content = res.content;
            if (res.how !== 'exact') fuzzy.push(res.how);
        }
        edits++;
    }
    if (!edits) errors.push('no edit blocks found');
    return { content, edits, errors, fuzzy };
}

export function readText(path) {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf8');
    return { text: raw.replace(/\r\n/g, '\n'), crlf: raw.includes('\r\n') };
}

// Writes through a temp file and a rename, so a reader never sees half a file and a hard link to the old
// contents is never written through. Falls back to a plain write if the rename is refused (a locked file).
export function writeText(path, text, crlf) {
    mkdirSync(dirname(path), { recursive: true });
    const body = crlf ? text.replace(/\n/g, '\r\n') : text;
    const tmp = `${path}.wgpt-${process.pid}-${Math.random().toString(36).slice(2, 8)}.tmp`;
    try {
        // The replacement keeps the old file's mode (an executable script stays executable).
        let mode;
        try { mode = statSync(path).mode & 0o7777; } catch { /* a new file */ }
        writeFileSync(tmp, body, mode === undefined ? undefined : { mode });
        if (mode !== undefined) chmodSync(tmp, mode); // the umask may have narrowed it
        renameSync(tmp, path);
    } catch {
        rmSync(tmp, { force: true });
        writeFileSync(path, body);
    }
}

// Works out every write in memory, without touching a file; throws listing every problem.
export function planFiles(text, allowed, stats) {
    const blocks = parseBlocks(text);
    if (!blocks.length) throw new Error(`Reply had no file blocks (${stats}); nothing written.`);

    const plan = new Map();
    const errors = [];
    for (const [rawPath, body] of blocks) {
        const path = matchAllowed(rawPath, allowed);
        if (!path) {
            errors.push(`${rawPath}: not in files`);
            continue;
        }
        const prev = plan.get(path);
        const original = prev ? null : readText(path);
        const crlf = prev ? prev.crlf : original?.crlf ?? false;
        const current = prev ? prev.content : original?.text ?? null;
        if (body.includes('<<<<<<< SEARCH')) {
            if (current === null) {
                errors.push(`${path}: edit blocks for a file that does not exist`);
                continue;
            }
            const res = applyEdits(current, body);
            errors.push(...res.errors.map((e) => `${path}: ${e}`));
            plan.set(path, { content: res.content, crlf, created: prev?.created ?? false,
                edits: (prev?.edits ?? 0) + res.edits, fuzzy: [...(prev?.fuzzy ?? []), ...res.fuzzy] });
        } else {
            plan.set(path, { content: unfence(body).replace(/\n*$/, '\n'), crlf,
                created: prev ? prev.created : current === null, edits: prev?.edits ?? 0, fuzzy: prev?.fuzzy ?? [] });
        }
    }
    if (errors.length) throw new Error(`Nothing written (${stats}):\n- ${errors.join('\n- ')}`);

    const lines = [];
    for (const [path, f] of plan) {
        const fuzzy = f.fuzzy.length ? `; ${f.fuzzy.length} matched loosely: ${[...new Set(f.fuzzy)].join(', ')}` : '';
        lines.push(f.created ? `created ${path} (${f.content.split('\n').length - 1} lines)`
            : f.edits ? `edited ${path} (${f.edits} edit${f.edits === 1 ? '' : 's'}${fuzzy})` : `rewrote ${path}`);
    }
    const untouched = allowed.filter((a) => !plan.has(a));
    if (untouched.length) lines.push(`unchanged: ${untouched.join(', ')}`);
    return { plan, summary: `${lines.join('\n')}\n(${stats})` };
}

// Writes a plan; to(path) maps each file to where it goes (a parallel attempt's copy of the tree).
export function writePlan(plan, to = (p) => p) {
    for (const [path, f] of plan) writeText(to(path), f.content, f.crlf);
}

// Works out every write in memory first, so a bad block leaves all files untouched.
export function writeFiles(text, allowed, stats) {
    const { plan, summary } = planFiles(text, allowed, stats);
    writePlan(plan);
    return summary;
}
