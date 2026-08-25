/** The `postgres` node kind's descriptor: one Prisma Postgres Database (plus its Connection), warmed before any consumer deploys. */

import type { NodeDescriptor } from '@internal/core/config';
import type { Lowering } from '@internal/core/deploy';
import * as Effect from 'effect/Effect';
import { PgWarm } from '../pg-warm-resource.ts';
import { type ResolvedCloudOptions, stageDatabase, validateName } from './shared.ts';

/**
 * One Database per module-provisioned postgres resource — `id` is the
 * module provision id, so a resource shared by several consumers is created
 * exactly once.
 */
export function postgresDescriptor(o: () => ResolvedCloudOptions): NodeDescriptor {
  const lowering: Lowering = ({ id, application }) =>
    Effect.gen(function* () {
      validateName(id, 'resource name (from provision id)');
      const { db, url } = yield* stageDatabase({ id, application, region: o().region });
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
