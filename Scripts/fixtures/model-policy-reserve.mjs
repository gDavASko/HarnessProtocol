// Cross-process atomic-reservation fixture; no transport is dispatched.
import { authorizeModelCall, createModelTestHarness } from '../modelPolicy.js';
const [studioProfile, runDir, runId] = process.argv.slice(2);
const testHarness = createModelTestHarness({ cli() { throw new Error('must never spawn'); } });
try {
    await authorizeModelCall({ provider: 'claude', model: 'fixture-model', role: 'worker', effort: 'high' }, { studioProfile, runDir, runId, testHarness });
    process.stdout.write('reserved');
} catch (err) {
    process.stdout.write(err.code || err.message);
    process.exitCode = 3;
}
