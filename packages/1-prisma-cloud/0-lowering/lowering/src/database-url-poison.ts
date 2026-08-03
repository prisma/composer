/**
 * Claiming the platform's `DATABASE_URL` / `DATABASE_URL_POOLED` environment
 * variables for the app's project, with a value that cannot connect anywhere.
 *
 * The problem this solves: when a project has no project-level production
 * `DATABASE_URL`, Prisma Cloud fills one in by itself on the next compute
 * deploy — picking one of the project's own ready databases — and injects it
 * into every service the project runs. A service that read
 * `process.env.DATABASE_URL` directly, behind the framework's back, would then
 * hold live credentials for a database nothing wired it to. Claiming both keys
 * with `"-"` first means the platform finds them taken and writes nothing.
 *
 * `"-"`, not `""`: the API rejects an empty value ("String must contain at
 * least 1 character"). Any real connect attempt against `"-"` fails loudly,
 * which is the point.
 *
 * These variables are NOT alchemy resources, deliberately. They are not
 * Composer's to own: it must never patch or delete one, and a state row would
 * plan exactly those calls. They stay out of the deploy state entirely — the
 * only call ever made for them is the create below.
 */

import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import { type ManagementApiClient, ManagementClient } from './client.ts';
import { callCreateOnly, type PrismaApiError } from './http.ts';

const POISON_VALUE = '-';

/** The two names Prisma Cloud fills in for itself, and that no Composer service may bind. */
const POISON_KEYS = ['DATABASE_URL', 'DATABASE_URL_POOLED'] as const;

/**
 * Both environment classes, each at PROJECT level (no branch id). A preview
 * branch with no override of its own reads the project-level preview row, so
 * these two rows cover every stage the app will ever deploy — including
 * stages that do not exist yet.
 */
const POISON_CLASSES = ['production', 'preview'] as const;

const claim = (
  client: ManagementApiClient,
  projectId: string,
  key: string,
  environmentClass: (typeof POISON_CLASSES)[number],
) =>
  callCreateOnly(() =>
    client.POST('/v1/environment-variables', {
      body: { projectId, class: environmentClass, key, value: POISON_VALUE },
    }),
  );

/**
 * Claims both keys in both classes for `projectId`, create-only: a 409 means
 * the variable already exists — whether Prisma Cloud seeded it or an earlier
 * deploy claimed it — and is skipped, never overwritten and never removed. So
 * this is a no-op on a project that already has the rows, and repeating it is
 * always safe.
 *
 * Does nothing when no {@link ManagementClient} is in context: that is the
 * local target, which has no Management API at all and no platform to fill a
 * `DATABASE_URL` in.
 */
export const claimPoisonDatabaseUrl = (projectId: string): Effect.Effect<void, PrismaApiError> =>
  Effect.gen(function* () {
    const client = yield* Effect.serviceOption(ManagementClient);
    if (Option.isNone(client)) return;
    for (const key of POISON_KEYS) {
      for (const environmentClass of POISON_CLASSES) {
        yield* claim(client.value, projectId, key, environmentClass);
      }
    }
  });
