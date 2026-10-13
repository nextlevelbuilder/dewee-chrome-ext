// Copies the versioned `dewee.ui-action.v1` contract (golden JSON Schema + examples) from a local
// checkout of nextlevelbuilder/dewee into tests/contract-fixtures, and records the source commit.
// Usage: node scripts/sync-dewee-contract.mjs <path-to-dewee-checkout>
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dewee = resolve(process.argv[2] ?? '../dewee');
const source = join(dewee, 'internal/setup/uiaction/testdata');
const target = resolve('tests/contract-fixtures/ui-action-v1');

const commit = execFileSync('git', ['-C', dewee, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(join(source, 'ui-action.v1.schema.golden.json'), join(target, 'schema.json'));
cpSync(join(source, 'examples'), join(target, 'examples'), { recursive: true });
writeFileSync(join(target, 'SOURCE.json'), `${JSON.stringify({ repo: 'nextlevelbuilder/dewee', commit }, null, 2)}\n`);
console.warn(`synced ui-action contract from ${commit}`);
