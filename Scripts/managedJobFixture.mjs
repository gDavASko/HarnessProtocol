// Local process double for test_unity_runtime.mjs. This is never a Unity simulator/certification.
import fs from 'node:fs';
import { acquireProjectLock } from './managedJob.mjs';
const [mode, ...args] = process.argv.slice(2);
if (mode === 'echo') {
    fs.writeFileSync(args[0], JSON.stringify(args.slice(1)));
    console.log('local child completed');
} else if (mode === 'hang') {
    setInterval(() => {}, 1000);
} else if (mode === 'fail') {
    console.error('intentional local child failure');
    process.exitCode = 7;
} else if (mode === 'lock') {
    try { acquireProjectLock(args[0], args[1]); console.log('acquired'); }
    catch (error) { console.error(error.message); process.exitCode = 9; }
} else throw new Error('Unknown local fixture mode');
