import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBlocks, findMatch, replaceOnce, applyEdits } from '../edits.mjs';

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
