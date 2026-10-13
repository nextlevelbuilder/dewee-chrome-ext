// Builds the extension for Playwright into .output-e2e/chrome-mv3 (see wxt.config.ts).
import { execSync } from 'node:child_process';

execSync('pnpm exec wxt build', { stdio: 'inherit', env: { ...process.env, DEWEE_E2E: '1' } });
