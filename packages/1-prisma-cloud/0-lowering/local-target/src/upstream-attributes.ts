/**
 * Shared helpers for the upstream-attribute records every local provider
 * emits — one implementation, so the compute and postgres families cannot
 * drift on the `'local'` project fallback or the timestamp.
 */

import * as Predicate from 'effect/Predicate';

/** The fixed `createdAt`/`updatedAt` local providers stamp: local dev has no meaningful creation time. */
export const DEV_TIMESTAMP = '1970-01-01T00:00:00.000Z';

/** Reads a project id from upstream's `project` input: a plain string or a resolved `Prisma.Project` attributes record. */
export function projectIdOfInput(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Predicate.isObject(value) && typeof value['projectId'] === 'string') {
    return value['projectId'];
  }
  return 'local';
}
