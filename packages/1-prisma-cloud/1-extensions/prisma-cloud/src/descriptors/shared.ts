/** Helpers shared by the per-node-kind descriptors under `src/descriptors/` and the extension factory in `control.ts`. */

import { blindCast } from '@internal/foundation/casts';
import type * as Prisma from '@internal/lowering';

/**
 * The factory's resolved options each node descriptor closes over. `projectId`
 * and `branchId` come from the CLI (stage-as-branch): a named stage sets
 * `branchId`, routing every branch-scoped resource there with the `preview` class.
 */
export interface ResolvedCloudOptions {
  readonly workspaceId: string;
  readonly region?: Prisma.ComputeRegion;
  readonly projectId: string | undefined;
  readonly branchId: string | undefined;
}

/** Where a resource lands when the deploy names no region. */
export const DEFAULT_REGION: Prisma.ComputeRegion = 'us-east-1';

// Prisma's Connection create constrains `name` to 3–65 chars (Management API:
// POST /v1/connections); applied here to every id-derived resource name as the
// tightest of the API's name-length rules.
const PRISMA_NAME_MIN = 3;
const PRISMA_NAME_MAX = 65;

export function validateName(value: string, source: string): void {
  if (value.length < PRISMA_NAME_MIN || value.length > PRISMA_NAME_MAX) {
    throw new Error(
      `prisma-cloud: ${source} "${value}" (${value.length} characters) is not a valid Prisma ` +
        `resource name — Prisma requires ${PRISMA_NAME_MIN}–${PRISMA_NAME_MAX} characters. ` +
        'Rename the provision id (or the deploy --name) to fit.',
    );
  }
}

/** The application/provisioned hook's `projectId` output — `LoweredNode.outputs` is typed `unknown`, so this is the one asserted read. */
export const projectIdOf = (hook: {
  readonly outputs: Readonly<Record<string, unknown>>;
}): string =>
  blindCast<
    string,
    'the projectId output is a provisioning string ref the application hook produced; LoweredNode.outputs is typed unknown'
  >(hook.outputs['projectId']);
