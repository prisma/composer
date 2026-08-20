/**
 * Claims the platform's `DATABASE_URL` / `DATABASE_URL_POOLED` variables for
 * the app's project with the placeholder `"-"`, before the platform can seed
 * them: on a project with no production `DATABASE_URL`, Prisma Cloud fills
 * one in on the next compute deploy, handing live credentials to any service
 * that reads `process.env.DATABASE_URL` behind the framework's back. The
 * claim is create-only, so whoever writes first wins; any connect attempt
 * against `"-"` fails loudly (the API rejects an empty value).
 *
 * Deliberately NOT alchemy resources: Composer must never patch or delete
 * these variables, and a state row would plan exactly those calls.
 */

import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import { type ManagementApiClient, ManagementClient } from './client.ts';
import { callCreateOnly, type PrismaApiError } from './http.ts';

const PLACEHOLDER_VALUE = '-';

/** The two names Prisma Cloud fills in for itself, and that no Composer service may bind. */
export const RESERVED_DATABASE_URL_KEYS = ['DATABASE_URL', 'DATABASE_URL_POOLED'] as const;

/**
 * Both environment classes, each at PROJECT level (no branch id). A preview
 * branch with no override of its own reads the project-level preview row, so
 * these two rows cover every stage the app will ever deploy — including
 * stages that do not exist yet.
 */
const ENVIRONMENT_CLASSES = ['production', 'preview'] as const;

const claim = (
  client: ManagementApiClient,
  projectId: string,
  key: string,
  environmentClass: (typeof ENVIRONMENT_CLASSES)[number],
) =>
  callCreateOnly(() =>
    client.POST('/v1/environment-variables', {
      body: { projectId, class: environmentClass, key, value: PLACEHOLDER_VALUE },
    }),
  );

/**
 * Claims both keys in both classes for `projectId`, create-only: a 409 means
 * the variable already exists — whether Prisma Cloud seeded it or an earlier
 * deploy claimed it — and is skipped, never overwritten and never removed.
 * Repeating it is always safe. Does nothing when no {@link ManagementClient}
 * is in context (the local target has no Management API).
 */
export const claimDatabaseUrlKeys = (projectId: string): Effect.Effect<void, PrismaApiError> =>
  Effect.gen(function* () {
    const client = yield* Effect.serviceOption(ManagementClient);
    if (Option.isNone(client)) return;
    for (const key of RESERVED_DATABASE_URL_KEYS) {
      for (const environmentClass of ENVIRONMENT_CLASSES) {
        yield* claim(client.value, projectId, key, environmentClass);
      }
    }
  });
