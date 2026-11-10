import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBlocks, findMatch, replaceOnce, applyEdits, writeText, missHint } from '../edits.mjs';

const edit = (search, replace) => `<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE`;

test('parseBlocks: a last block without its end marker still counts', () => {
    const text = `Some prose first.\n=== FILE: a.js ===\n${edit('x', 'y')}\n=== END FILE ===\nmore prose\n` +
        `=== FILE: b.js ===\n${edit('p', 'q')}\n`;
    const blocks = parseBlocks(text);
    assert.deepEqual(blocks.map((b) => b[0]), ['a.js', 'b.js']);
    assert.equal(blocks[0][1], edit('x', 'y'));
    assert.match(blocks[1][1], /SEARCH\np\n=======\nq\n>>>>>>> REPLACE$/);
});

test('parseBlocks: a block missing its end marker stops at the next header', () => {
    const blocks = parseBlocks(`=== FILE: a.js ===\nnew a\n=== FILE: b.js ===\nnew b\n=== END FILE ===`);
    assert.deepEqual(blocks, [['a.js', 'new a'], ['b.js', 'new b']]);
});

test('findMatch: exact first, ambiguity refused', () => {
    assert.equal(findMatch('a\nb\nc\n', 'b').how, 'exact');
    assert.match(findMatch('b\nb\n', 'b').error, /matches 2 places/);
    assert.match(findMatch('a\n', 'zzz').error, /^search text not found$/);
});

test('findMatch: trailing spaces and blank edge lines still match', () => {
    const content = 'function f() {\n    return 1;   \n}\n';
    const m = findMatch(content, '\nfunction f() {\n    return 1;\n}\n\n');
    assert.equal(m.how, 'indentation-flexible');
    assert.equal(content.slice(m.start, m.end), 'function f() {\n    return 1;   \n}');
});

test('findMatch: whitespace-normalized tolerates changed inner spacing', () => {
    const m = findMatch('if (a  &&   b) {\n  go();\n}\n', 'if (a && b) {\n  go();\n}');
    assert.equal(m.how, 'whitespace-normalized');
});

test('replaceOnce: indentation is shifted to match the file', () => {
    const content = 'class A {\n    m() {\n        return 1;\n    }\n}\n';
    const res = replaceOnce(content, 'm() {\n    return 1;\n}', 'm() {\n    return 2;\n}');
    assert.equal(res.how, 'indentation-flexible');
    assert.equal(res.content, 'class A {\n    m() {\n        return 2;\n    }\n}\n');
});

test('findMatch: indentation-flexible keeps relative indentation strict', () => {
    // Same block one level deeper: flexible. Inner lines shifted unevenly: only line-trimmed accepts it.
    const content = 'x\n\tif (a) {\n\t\tb();\n\t}\n';
    const m = findMatch(content, 'if (a) {\n\tb();\n}');
    assert.equal(m.how, 'indentation-flexible');
    assert.equal(content.slice(m.start, m.end), '\tif (a) {\n\t\tb();\n\t}');
    assert.equal(findMatch(content, 'if (a) {\nb();\n}').how, 'line-trimmed');
});

test('findMatch: loose matches that hit two places are refused', () => {
    const m = findMatch('  a();\nb\n    a();\n', 'a(); ');
    assert.match(m.error, /matches 2 places \(indentation-flexible\)/);
});

test('findMatch: a near miss says where its first line is', () => {
    const m = findMatch('one\ntwo\nthree\n', 'two\nTHREE');
    assert.match(m.error, /first line is at line 2/);
});

test('applyEdits: reports loose matches and keeps going after a failed edit', () => {
    const res = applyEdits('a  \nb\nc\n', `${edit('a\nb', 'A\nB')}\n${edit('zz', 'Z')}`);
    assert.deepEqual(res.fuzzy, ['indentation-flexible']);
    assert.deepEqual(res.errors, ['edit 2: search text not found']);
    assert.equal(res.content, 'A\nB\nc\n');
});

test('writeText keeps the file mode: an executable stays executable, a private file stays private', { skip: process.platform === 'win32' }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'warriorgpt-mode-'));
    try {
        for (const mode of [0o755, 0o600]) {
            const f = join(dir, `f-${mode.toString(8)}`);
            writeFileSync(f, 'old\n');
            chmodSync(f, mode);
            writeText(f, 'new\n', false);
            assert.equal(statSync(f).mode & 0o777, mode);
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('findMatch: a search copied with read_file line numbers matches without them, still only once', () => {
    const content = 'const a = 1;\nconst b = 2;\nconst c = 3;\n';
    const res = replaceOnce(content, '2: const b = 2;\n3: const c = 3;', '2: const b = 20;\n3: const c = 30;');
    assert.equal(res.how, 'line numbers removed');
    assert.equal(res.content, 'const a = 1;\nconst b = 20;\nconst c = 30;\n', 'the numbers are left out of the replacement too');
    assert.equal(replaceOnce(content, '2: const b = 2;', 'const b = 9;').content, 'const a = 1;\nconst b = 9;\nconst c = 3;\n');
    assert.match(findMatch('x = 1\nx = 1\n', '1: x = 1').error, /matches 2 places/, 'the must-be-unique rule holds');
    assert.equal(findMatch('see 12: done\n', '12: done').how, 'exact', 'text that really has the prefix matches as it is');
    assert.match(findMatch(content, 'const b = 2;\n3: const c = 3;').error, /not found/, 'only when every line has a prefix');
});

test('findMatch: smart quotes, dashes and non-breaking spaces match their plain forms as a last resort', () => {
    const content = "say('it’s fine') — ok\nx = 1\n";
    assert.equal(findMatch(content, "say('it's fine') - ok").how, 'unicode-normalized');
    assert.equal(findMatch(content, 'x = 1').how, 'whitespace-normalized', 'a non-breaking space is already whitespace');
    assert.match(findMatch('a — b\na - b\n', 'a - b').how, /exact/, 'an exact match still wins');
    assert.match(findMatch('a — b\nc\na – b\nc\n', 'a - b\nc').error, /matches 2 places \(unicode-normalized\)/);
});

test('missHint: an edit that already applied, or the closest lines with their numbers', () => {
    const content = 'function f() {\n    const total = sum(items);\n    return total * 2;\n}\n';
    assert.equal(missHint(content, 'return total;', '    const total = sum(items);\n    return total * 2;'),
        'The replace text is already in the file, so this edit may already be applied.');
    const hint = missHint(content, 'function f() {\n    const total = add(items);\n    return total * 2;\n}', 'x');
    assert.equal(hint, 'The closest lines in the file:\n1: function f() {\n2:     const total = sum(items);\n3:     return total * 2;\n4: }');
    assert.equal(missHint(content, 'nothing like it', 'y'), '', 'no hint when too few lines agree');
    const res = replaceOnce(content, 'function f() {\n  return total * 2;', 'z');
    assert.match(res.error, /^search text not found/);
    assert.match(res.hint, /^The closest lines in the file:\n1: function f\(\) \{/);
    assert.match(applyEdits(content, edit('function f() {\n  return total * 2;', 'z')).errors[0], /^edit 1: search text not found.*\nThe closest lines in the file:/);
});
