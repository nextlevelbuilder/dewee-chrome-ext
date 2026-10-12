// Zips the Chrome Web Store build into .output-store: same code, manifest without `key` (see wxt.config.ts).
import { execSync } from 'node:child_process';

execSync('pnpm exec wxt zip', { stdio: 'inherit', env: { ...process.env, DEWEE_STORE: '1' } });
