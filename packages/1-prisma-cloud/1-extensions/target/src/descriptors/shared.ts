/** Helpers shared by the per-node-kind descriptors under `src/descriptors/` and the extension factory in `control.ts`. */

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

/** What prisma-cloud's application hook produces; its own descriptors are the only consumers. */
export interface CloudApplication {
  readonly projectId: string;
}

export function isCloudApplication(value: unknown): value is CloudApplication {
  // `in` narrows without a cast — TS carries the key through to the read.
  return (
    typeof value === 'object' &&
    value !== null &&
    'projectId' in value &&
    typeof value.projectId === 'string'
  );
}

/** Narrows ctx.application at the extension seam; throws naming the seam when the hook didn't run. */
export function projectIdOf(application: unknown): string {
  if (!isCloudApplication(application)) {
    throw new Error(
      "prisma-cloud: ctx.application is not this extension's application product — " +
        'the prismaCloud() application hook must run before any node lowers.',
    );
  }
  return application.projectId;
}
