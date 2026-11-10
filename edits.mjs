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
// Typographic quotes, dashes and odd spaces as their plain ASCII forms.
const plain = (text) => text.replace(/[\u2018\u2019\u201A\u201B]/g, "'").replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-').replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ');
const LINE_MATCHERS = [
    // Same lines, ignoring leading and trailing whitespace on each.
    ['line-trimmed', (line) => line.trim()],
    // Same tokens: every run of whitespace counts as one space.
    ['whitespace-normalized', (line) => line.trim().replace(/\s+/g, ' ')],
    // The same again after plain quotes, dashes and spaces: a search retyped with smart punctuation.
    ['unicode-normalized', (line) => plain(line).trim().replace(/\s+/g, ' ')],
];
// read_file shows lines as "12: text"; a search copied with those prefixes on every line has them removed.
const NUMBERED = /^\d+: ?/;
const numbered = (text) => {
    const lines = text.split('\n').filter((l) => l.trim());
    return lines.length > 0 && lines.every((l) => NUMBERED.test(l));
};
const unnumber = (text) => text.split('\n').map((l) => l.replace(NUMBERED, '')).join('\n');

const HINT_LINES = 12;
const HINT_LINE_CHARS = 200;
// A short hint for a search that missed: the replacement is already there (an edit that already applied), or the
// lines closest to the search, numbered as read_file shows them. Each search line votes for where the search starts
// when it matches a file line ignoring whitespace; at least half must agree.
export function missHint(content, search, replace = '') {
    const key = (l) => plain(l).replace(/\s+/g, ' ').trim();
    if (replace.trim().length >= 20 && key(content.replace(/\s+/g, ' ')).includes(key(replace.replace(/\s+/g, ' ')))) {
        return 'The replace text is already in the file, so this edit may already be applied.';
    }
    const lines = content.split('\n');
    const wantedLines = search.split('\n');
    const distinct = (v) => /[\p{L}\p{N}]/u.test(v);
    const positions = new Map();
    lines.forEach((l, i) => {
        const v = key(l);
        if (distinct(v)) positions.set(v, [...(positions.get(v) || []), i]);
    });
    const votes = new Map();
    let wanted = 0;
    wantedLines.forEach((l, off) => {
        const v = key(l);
        if (!distinct(v)) return;
        wanted++;
        for (const i of positions.get(v) || []) votes.set(i - off, (votes.get(i - off) || 0) + 1);
    });
    const [start, count] = [...votes].reduce((best, v) => (v[1] > best[1] ? v : best), [0, 0]);
    if (!count || count * 2 < wanted) return '';
    const matched = wantedLines.flatMap((l, off) => {
        const i = start + off;
        return key(l) && i >= 0 && i < lines.length && key(lines[i]) === key(l) ? [i] : [];
    });
    const from = matched[0];
    const to = Math.min(matched.at(-1) + 1, from + HINT_LINES);
    return ['The closest lines in the file:', ...lines.slice(from, to)
        .map((l, i) => `${from + i + 1}: ${l.length > HINT_LINE_CHARS ? `${l.slice(0, HINT_LINE_CHARS)}...` : l}`)].join('\n');
}

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

export function findMatch(content, search, stripped = false) {
    if (search === '') return { error: 'search text is empty' };
    // Line-number prefixes copied from read_file: match without them (only when the text as given does not match).
    if (!stripped && numbered(search) && !content.includes(search)) {
        const m = findMatch(content, unnumber(search), true);
        if (!m.error) return { ...m, how: m.how === 'exact' ? 'line numbers removed' : `line numbers removed, ${m.how}`, unnumbered: true };
        if (/matches \d+ places/.test(m.error)) return m;
    }
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
    if (m.error) return { ...m, hint: missHint(content, numbered(search) ? unnumber(search) : search, replace) };
    // A search copied with line numbers usually has them in the replacement too.
    const bare = m.unnumbered && numbered(replace) ? unnumber(replace) : replace;
    const text = m.indent ? reindent(bare, m.indent) : bare;
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
        if (res.error) errors.push(`edit ${edits + 1}: ${res.error}${res.hint ? `\n${res.hint}` : ''}`);
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
