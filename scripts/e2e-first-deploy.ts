#!/usr/bin/env bun
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import {
  layer,
  ManagementClient,
} from '../packages/1-prisma-cloud/0-lowering/lowering/src/client.ts';
import {
  isProductionEnvironment,
  resolveContainer,
} from '../packages/1-prisma-cloud/0-lowering/lowering/src/container.ts';
import { fromEnv } from '../packages/1-prisma-cloud/0-lowering/lowering/src/credentials.ts';
import { call } from '../packages/1-prisma-cloud/0-lowering/lowering/src/http.ts';

const usage =
  'Usage: e2e-first-deploy.ts <NAME> [<NAME> ...], run from the app directory, with STACK_NAME, ENVIRONMENT, PRISMA_WORKSPACE_ID, GITHUB_WORKSPACE and each NAME set';

function fail(message: string): never {
  console.error(`::error::${message}`);
  process.exit(1);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) fail(`${name} is required. ${usage}`);
  return value;
}

const names = process.argv.slice(2);
if (names.length === 0) fail(usage);
const stackName = requiredEnv('STACK_NAME');
const environment = requiredEnv('ENVIRONMENT');
const workspaceId = requiredEnv('PRISMA_WORKSPACE_ID');
const workspace = requiredEnv('GITHUB_WORKSPACE');
const variables = names.map((key) => ({ key, value: requiredEnv(key) }));

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function deployError(stdout: string): { readonly code: string; readonly summary: string } {
  const last = stdout.trim().split('\n').at(-1) ?? '';
  let frame: unknown;
  try {
    frame = JSON.parse(last);
  } catch {
    fail(`The first deploy's last output line is not JSON: ${last}`);
  }
  const envelope = isRecord(frame) ? frame['envelope'] : undefined;
  const error = isRecord(envelope) ? envelope['error'] : undefined;
  if (
    !isRecord(error) ||
    typeof error['code'] !== 'string' ||
    typeof error['summary'] !== 'string'
  ) {
    fail(`The first deploy's result has no error: ${last}`);
  }
  return { code: error['code'], summary: error['summary'] };
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
    '--json',
  ],
  { stdout: 'pipe', stderr: 'inherit' },
);
const stdout = deploy.stdout.toString();
console.log(stdout);

if (deploy.exitCode === 0) {
  fail(`The first deploy succeeded, but the new project has no value for: ${names.join(', ')}`);
}
const error = deployError(stdout);
if (error.code !== 'DEPLOY.PREFLIGHT_FAILED') {
  fail(`The first deploy failed with ${error.code}, not DEPLOY.PREFLIGHT_FAILED`);
}
const wordsInError = new Set(error.summary.split(/[^A-Za-z0-9_]+/));
for (const name of names) {
  if (!wordsInError.has(name)) fail(`The first deploy stopped at preflight without naming ${name}`);
}

const program = Effect.gen(function* () {
  const { projectId, branchId } = yield* resolveContainer({
    workspaceId,
    appName: stackName,
    environment,
    ensure: false,
  });
  const scope = isProductionEnvironment(environment)
    ? { class: 'production' as const }
    : branchId === undefined
      ? undefined
      : { class: 'preview' as const, branchId };
  if (scope === undefined) {
    return yield* Effect.fail(
      new Error(`Project ${projectId} has no branch for the environment ${environment}.`),
    );
  }
  const client = yield* ManagementClient;
  for (const { key, value } of variables) {
    yield* call(() =>
      client.POST('/v1/environment-variables', { body: { projectId, ...scope, key, value } }),
    );
    const where = 'branchId' in scope ? `preview, branch ${scope.branchId}` : 'production';
    console.log(`Set ${key} on project ${projectId} (${where}).`);
  }
});

await Effect.runPromise(program.pipe(Effect.provide(layer().pipe(Layer.provideMerge(fromEnv())))));
