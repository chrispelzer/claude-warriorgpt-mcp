// Stands in for `opencode run` in the runner tests. FAKE_OC picks the behaviour; FAKE_OC_LOG records the call.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// node --test also runs this file directly, with nothing on stdin.
if (!process.env.WARRIORGPT_OPENCODE) process.exit(0);

const brief = readFileSync(0, 'utf8');
const dir = process.env.PWD;
if (process.env.FAKE_OC_LOG) {
    writeFileSync(process.env.FAKE_OC_LOG, JSON.stringify({ argv: process.argv.slice(2), pwd: dir, brief,
        config: JSON.parse(readFileSync(process.env.OPENCODE_CONFIG, 'utf8')) }));
}

const sessionID = 'ses_fake';
const emit = (part) => console.log(JSON.stringify({ type: part.type, sessionID, part }));
const handoff = (status) => emit({ type: 'text', text: `HANDOFF\nSTATUS: ${status}\nDeviations from the brief: none` });

switch (process.env.FAKE_OC) {
    case 'done':
        writeFileSync(`${dir}/new.txt`, 'hello\n');
        if (process.env.FAKE_OC_COMMIT) {
            execFileSync('git', ['add', 'new.txt'], { cwd: dir });
            execFileSync('git', ['commit', '-q', '-m', 'add new.txt'], { cwd: dir });
        }
        emit({ type: 'tool', tool: 'write', state: { status: 'completed' } });
        emit({ type: 'step-finish', tokens: { input: 100, output: 20, reasoning: 5 } });
        handoff('DONE');
        break;
    case 'ask':
        emit({ type: 'text', text: 'HANDOFF\nSTATUS: NEEDS_INPUT\nQUESTIONS: 1. a or b? default: a' });
        break;
    case 'nochange':
        handoff('DONE');
        break;
    case 'partial':
        writeFileSync(`${dir}/new.txt`, 'hello\n');
        handoff('PARTIAL');
        break;
    case 'answer':
        emit({ type: 'text', text: 'calc.py:1 defines add.' });
        break;
    case 'hang':
        setInterval(() => {}, 1000);
        break;
}
