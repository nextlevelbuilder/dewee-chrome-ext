// Builds the extension for Playwright: Standard into .output-e2e/chrome-mv3 and Advanced into
// .output-e2e-advanced/chrome-mv3 (see wxt.config.ts). `--profile standard|advanced` builds one only.
import { execSync } from 'node:child_process';

const flag = process.argv.indexOf('--profile');
const only = flag === -1 ? null : process.argv[flag + 1];
if (only !== null && only !== 'standard' && only !== 'advanced') throw new Error(`Unknown profile "${only}"`);

for (const profile of only ? [only] : ['standard', 'advanced']) {
  execSync('pnpm exec wxt build', { stdio: 'inherit', env: { ...process.env, DEWEE_E2E: '1', DEWEE_PROFILE: profile } });
}
