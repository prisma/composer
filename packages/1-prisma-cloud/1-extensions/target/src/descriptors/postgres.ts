/** The `postgres` node kind's descriptor: one Prisma Postgres Database (plus its Connection), warmed before any consumer deploys. */

import type { NodeDescriptor } from '@internal/core/config';
import type { Lowering } from '@internal/core/deploy';
import * as Output from 'alchemy/Output';
import * as Prisma from 'alchemy/Prisma';
import * as Effect from 'effect/Effect';
import * as Redacted from 'effect/Redacted';
import { PgWarm } from '../pg-warm-resource.ts';
import {
  attachmentBranchIdOf,
  DEFAULT_REGION,
  projectIdOf,
  type ResolvedCloudOptions,
  validateName,
} from './shared.ts';

/**
 * One Database per module-provisioned postgres resource — `id` is the
 * module provision id, so a resource shared by several consumers is created
 * exactly once.
 */
export function postgresDescriptor(o: () => ResolvedCloudOptions): NodeDescriptor {
  const lowering: Lowering = ({ id, application }) =>
    Effect.gen(function* () {
      validateName(id, 'resource name (from provision id)');
      // Upstream refuses an explicit display name combined with branch
      // attachment at create (the Management API creates the database before
      // attaching the branch and exposes no idempotency key), so the name is
      // omitted: upstream creates under its recoverable generated physical
      // name WITH the branchId in the create call, and `branchId` staying in
      // props keeps the attachment reconciled on every later deploy. Only the
      // dev container resolves no Branch (ADR-0041), so the `name` arm is
      // local-dev only.
      const branchId = attachmentBranchIdOf(application, id);
      const db = yield* Prisma.Database(`${id}-db`, {
        project: projectIdOf(application),
        region: o().region ?? DEFAULT_REGION,
        ...(branchId !== undefined ? { branchId } : { name: id }),
      });
      const conn = yield* Prisma.Connection(`${id}-conn`, { database: db, name: id });
      // Composer's semantics stay DIRECT: PgWarm and the migration flows
      // depend on a direct connection, and upstream's `databaseUrl` is
      // pooled-first — so bind `directConnectionString` explicitly.
      const url = Output.map(conn.directConnectionString, (value) => {
        if (value === undefined) {
          throw new Error(
            `prisma-cloud: connection "${id}-conn" returned no direct connection string.`,
          );
        }
        return Redacted.value(value);
      });
      // Warm the DB so a consumer's first connect doesn't eat PPG's cold-start
      // (FT-5226). `warm.url` is the same url, so consumers depend on the warm.
      const warm = yield* PgWarm(`${id}-warm`, { url });
      // No `url` on the entity: a Postgres connection string is not a public
      // endpoint. `url` on an entity means publicly reachable BECAUSE the
      // descriptor said so — core has no rule that could infer it, and the
      // same key means the opposite thing here as it does on compute.
      return {
        outputs: { url: warm.url },
        entities: [{ kind: 'postgres-database', id: db.databaseId }],
      };
    });
  return Object.assign(lowering, { kind: 'resource' as const });
}
