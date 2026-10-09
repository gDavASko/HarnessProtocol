// Offline test fixture. Never invokes an LLM or a provider CLI.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
const [mode, bin, ...argv] = process.argv.slice(2);
if (mode === 'hang') setInterval(() => {}, 1000);
else {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { input += chunk; });
    process.stdin.on('end', () => {
        const stdinBytes = Buffer.byteLength(input, 'utf8');
        if (bin === 'agy') {
            const instruction = argv[argv.indexOf('-p') + 1];
            const match = instruction.match(/^Read task from file: (.+?) \. /);
            if (match) input = fs.readFileSync(match[1], 'utf8');
        }
        const answer = mode === 'receipt' ? JSON.stringify({
            channel: bin === 'agy' ? 'file' : 'stdin',
            stdinBytes,
            inputBytes: Buffer.byteLength(input, 'utf8'),
            inputSha256: createHash('sha256').update(input).digest('hex'),
            argvBytes: Buffer.byteLength(argv.join('\0'), 'utf8'),
            maxArgBytes: Math.max(0, ...argv.map(arg => Buffer.byteLength(arg, 'utf8')))
        }) : mode === 'large' ? 'x'.repeat(20000) : (input.match(/HNONCE-[A-F0-9]+/)?.[0] || 'fixture-ok');
        if (bin === 'codex') fs.writeFileSync(argv[argv.indexOf('-o') + 1], answer);
        else process.stdout.write(answer);
        if (mode === 'error') process.exitCode = 7;
    });
}
