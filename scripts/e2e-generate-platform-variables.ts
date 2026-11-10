#!/usr/bin/env bun
/**
 * Generates a random value for each named platform variable and exports it to
 * the later steps of the current GitHub Actions job through `$GITHUB_ENV`.
 * Masks each value in the job log. Never prints a value.
 *
 * Usage: e2e-generate-platform-variables.ts <NAME> [<NAME> ...]
 * Env: GITHUB_ENV (set by GitHub Actions).
 */

import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';

const names = process.argv.slice(2);
const githubEnv = process.env['GITHUB_ENV'];
if (names.length === 0 || !githubEnv) {
  console.error(
    'Usage: e2e-generate-platform-variables.ts <NAME> [<NAME> ...], with GITHUB_ENV set',
  );
  process.exit(1);
}

for (const name of names) {
  const value = randomBytes(32).toString('hex');
  console.log(`::add-mask::${value}`);
  appendFileSync(githubEnv, `${name}=${value}\n`);
  console.log(`Generated a random value for ${name}.`);
}
