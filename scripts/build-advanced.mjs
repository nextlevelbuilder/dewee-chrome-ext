// Builds (or zips, with `zip`) the Advanced profile into .output-advanced: same code, plus the
// `debugger` permission (see src/shared/build-profile.ts). Sideload only; it keeps the pinned key.
import { execSync } from 'node:child_process';

const command = process.argv[2] === 'zip' ? 'zip' : 'build';
execSync(`pnpm exec wxt ${command}`, { stdio: 'inherit', env: { ...process.env, DEWEE_PROFILE: 'advanced' } });
