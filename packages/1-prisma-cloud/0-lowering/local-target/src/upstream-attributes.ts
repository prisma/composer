/**
 * Shared pieces of the upstream-attribute shapes every local provider emits.
 * The compute and postgres provider families both fill upstream alchemy's
 * attribute records, so the timestamp they stamp and the way they read a
 * `project` reference live here — one implementation, so the two families
 * cannot drift on the `'local'` project fallback or on the timestamp.
 */

/** The fixed `createdAt`/`updatedAt` local providers stamp: local dev has no meaningful creation time. */
export const DEV_TIMESTAMP = '1970-01-01T00:00:00.000Z';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Reads a project id from upstream's `project` input: a plain string or a resolved `Prisma.Project` attributes record. */
export function projectIdOfInput(value: unknown): string {
  if (typeof value === 'string') return value;
  if (isRecord(value) && typeof value['projectId'] === 'string') return value['projectId'];
  return 'local';
}
