#!/usr/bin/env bun
/**
 * After a real deploy, checks that the stage Branch's App, Database and Bucket
 * rows carry the same `logicalId`s as the service and resource nodes of the
 * application topology the deploy submitted (ADR-0051). A mismatch would make
 * every Console lookup silently find nothing, so it fails here instead.
 *
 * Env: STACK_NAME (the `prisma deploy --name` value), PRISMA_SERVICE_TOKEN,
 * PRISMA_WORKSPACE_ID, and STAGE for a named stage (omit for the default one).
 */

import { identityMismatches } from './platform-identity.ts';
import { logPlatformState, readPlatformState } from './platform-state.ts';

const stackName = process.env['STACK_NAME'];
const workspaceId = process.env['PRISMA_WORKSPACE_ID'];
const stage = process.env['STAGE'] || undefined;
if (!stackName || !workspaceId) {
  console.error('STACK_NAME and PRISMA_WORKSPACE_ID are required');
  process.exit(1);
}

const state = await readPlatformState({ workspaceId, appName: stackName, stage });
logPlatformState(state);

const problems = identityMismatches(state.nodes, state.rows, state.branchId);
if (problems.length > 0) {
  console.error(`Platform identity mismatch:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('Every service, database and bucket row carries its topology node logicalId.');
