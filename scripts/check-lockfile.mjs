// Usage: node scripts/check-lockfile.mjs [directory]
// Checks package-lock.json against package.json in `directory` (default: the repository root).
// CI runs it with bare `node` before `npm ci`, so it must not import any installed package.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findLockfileProblems } from './lockfileSources.mjs';

const directory = process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url));

function readJson(name) {
  const path = join(directory, name);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    console.error(`[lockfile] Could not read ${path}: ${error.message}`);
    console.error('[lockfile] Resolve any merge conflict in it, or regenerate the lockfile with `npm install`.');
    process.exit(1);
  }
}

const lockfile = readJson('package-lock.json');
const problems = findLockfileProblems(lockfile, readJson('package.json'));

if (problems.length > 0) {
  console.error(`[lockfile] package-lock.json has ${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    '\nEvery package must be a published version from https://registry.npmjs.org/ with a sha512\n' +
      'integrity hash. Git, local-file, link and other URL dependencies are not accepted: depend on a\n' +
      'published version instead. Do not edit package-lock.json by hand. Regenerate it with `npm install`\n' +
      'against the default registry (check that no .npmrc points npm at another one), using npm 9 or later.',
  );
  process.exit(1);
}

console.log(
  `[lockfile] ${Object.keys(lockfile.packages).length - 1} packages resolve to the npm registry with sha512 integrity.`,
);
