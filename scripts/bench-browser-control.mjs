// Builds the Advanced e2e extension and runs the Standard vs Advanced latency benchmark
// (tests/e2e/bench-browser-control.spec.ts). Rounds: DEWEE_BENCH_ROUNDS (default 20).
import { execSync } from 'node:child_process';

execSync('node scripts/build-e2e.mjs --profile advanced', { stdio: 'inherit' });
execSync('pnpm exec playwright test tests/e2e/bench-browser-control.spec.ts', { stdio: 'inherit', env: { ...process.env, DEWEE_BENCH: '1' } });
