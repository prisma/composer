#!/usr/bin/env bun
/**
 * Runs the first deploy of a new e2e app whose services need platform
 * variables the fresh project does not have yet, and checks that preflight
 * refused it, naming each variable (ADR-0064).
 *
 * Usage: e2e-first-deploy-stops-at-preflight.ts <NAME> [<NAME> ...]
 * Run from the app's directory.
 * Env: STACK_NAME (the `prisma deploy --name` value), ENVIRONMENT (default production).
 */

const names = process.argv.slice(2);
const stackName = process.env['STACK_NAME'];
const environment = process.env['ENVIRONMENT'] || 'production';
const workspace = process.env['GITHUB_WORKSPACE'];
if (names.length === 0 || !stackName || !workspace) {
  console.error(
    'Usage: e2e-first-deploy-stops-at-preflight.ts <NAME> [<NAME> ...], with STACK_NAME and GITHUB_WORKSPACE set',
  );
  process.exit(1);
}

const deploy = Bun.spawnSync(
  [
    'bun',
    `${workspace}/node_modules/.bin/prisma`,
    'deploy',
    '--name',
    stackName,
    '--environment',
    environment,
  ],
  { stdout: 'pipe', stderr: 'pipe' },
);
const output = `${deploy.stdout.toString()}${deploy.stderr.toString()}`;
console.log(output);

const preflightRefusal =
  /Deploy failed\. \d+ platform variables? a service needs (has|have) no value/;

function fail(message: string): never {
  console.error(`::error::${message}`);
  process.exit(1);
}

if (deploy.exitCode === 0) {
  fail(`The first deploy succeeded, but the new project has no value for: ${names.join(', ')}`);
}
if (!preflightRefusal.test(output)) {
  fail('The first deploy failed, but not at preflight');
}
for (const name of names) {
  if (!new RegExp(`\\b${name}\\b`).test(output)) {
    fail(`The first deploy stopped at preflight without naming ${name}`);
  }
}
