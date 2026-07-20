/** The `postgres` node kind's descriptor: one Prisma Postgres Database (plus its Connection), warmed before any consumer deploys. */

import type { NodeDescriptor } from '@internal/core/config';
import type { Lowering } from '@internal/core/deploy';
import * as Prisma from '@internal/lowering';
import * as Output from 'alchemy/Output';
import * as Effect from 'effect/Effect';
import * as Redacted from 'effect/Redacted';
import { PgWarm } from '../pg-warm-resource.ts';
import { DEFAULT_REGION, projectIdOf, type ResolvedCloudOptions, validateName } from './shared.ts';

/**
 * One Database per module-provisioned postgres resource — `id` is the
 * module provision id, so a resource shared by several consumers is created
 * exactly once.
 */
export function postgresDescriptor(o: ResolvedCloudOptions): NodeDescriptor {
  const lowering: Lowering = ({ id, application }) =>
    Effect.gen(function* () {
      validateName(id, 'resource name (from provision id)');
      const db = yield* Prisma.Database(`${id}-db`, {
        projectId: projectIdOf(application),
        name: id,
        region: o.region ?? DEFAULT_REGION,
        ...(o.branchId !== undefined ? { branchId: o.branchId } : {}),
      });
      const conn = yield* Prisma.Connection(`${id}-conn`, { databaseId: db.id, name: id });
      const url = Output.map(conn.connectionString, (value) => Redacted.value(value));
      // Warm the DB so a consumer's first connect doesn't eat PPG's cold-start
      // (FT-5226). `warm.url` is the same url, so consumers depend on the warm.
      const warm = yield* PgWarm(`${id}-warm`, { url });
      // No `url` on the entity: a Postgres connection string is not a public
      // endpoint. `url` on an entity means publicly reachable BECAUSE the
      // descriptor said so — core has no rule that could infer it, and the
      // same key means the opposite thing here as it does on compute.
      return {
        outputs: { url: warm.url },
        entities: [{ kind: 'postgres-database', id: db.id }],
      };
    });
  return Object.assign(lowering, { kind: 'resource' as const });
}
