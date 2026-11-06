#!/usr/bin/env bun
/**
 * Sets platform variables on a per-run e2e project, the way an operator does
 * after the first deploy of a new app stops at preflight (ADR-0064). Each
 * named variable takes its value from this process's environment. Production
 * gets a production row; any other environment gets a preview row on its
 * Branch. Never prints a value.
 *
 * Usage: e2e-set-platform-variables.ts <NAME> [<NAME> ...]
 * Env: STACK_NAME (the `prisma deploy --name` value), PRISMA_SERVICE_TOKEN,
 * PRISMA_WORKSPACE_ID, and ENVIRONMENT (default production).
 */

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

const usage = 'Usage: e2e-set-platform-variables.ts <NAME> [<NAME> ...]';
const names = process.argv.slice(2);
if (names.includes('--help') || names.length === 0) {
  console.log(usage);
  process.exit(names.length === 0 ? 1 : 0);
}

const stackName = process.env['STACK_NAME'];
const workspaceId = process.env['PRISMA_WORKSPACE_ID'];
const environment = process.env['ENVIRONMENT'] || 'production';
if (!stackName || !workspaceId) {
  console.error('STACK_NAME and PRISMA_WORKSPACE_ID are required');
  process.exit(1);
}

interface Variable {
  readonly key: string;
  readonly value: string;
}
const hasValue = (entry: { key: string; value: string | undefined }): entry is Variable =>
  entry.value !== undefined && entry.value.length > 0;
const entries = names.map((key) => ({ key, value: process.env[key] }));
const variables = entries.filter(hasValue);
const unset = names.filter((key) => !variables.some((variable) => variable.key === key));
if (unset.length > 0) {
  console.error(`These variables have no value in the environment: ${unset.join(', ')}`);
  process.exit(1);
}

const program = Effect.gen(function* () {
  const container = yield* resolveContainer({
    workspaceId,
    appName: stackName,
    environment,
    ensure: false,
  });
  const { projectId, branchId } = container;
  const scope = isProductionEnvironment(environment)
    ? { class: 'production' as const }
    : branchId === undefined
      ? undefined
      : { class: 'preview' as const, branchId };
  if (scope === undefined) {
    return yield* Effect.fail(
      new Error(`project ${projectId} has no Branch for the environment ${environment}`),
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
