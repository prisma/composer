/** The `raw-postgres` node kind's descriptor: one Prisma Postgres Database (plus its Connection), warmed before any consumer deploys. */

import type { NodeDescriptor } from '@internal/core/config';
import type { Lowering } from '@internal/core/deploy';
import * as Effect from 'effect/Effect';
import { fromLegacyId, legacyNodeResourceId } from '../legacy-resource-ids.ts';
import { PgWarm } from '../pg-warm-resource.ts';
import { resourceId } from '../resource-ids.ts';
import { nodeDatabase, type ResolvedCloudOptions, validatePlatformName } from './shared.ts';

/**
 * One Database per module-provisioned postgres resource — `id` is the
 * module provision id, so a resource shared by several consumers is created
 * exactly once.
 */
export function rawPostgresDescriptor(o: () => ResolvedCloudOptions): NodeDescriptor {
  const lowering: Lowering = ({ id, address, application, graph }) =>
    Effect.gen(function* () {
      const app = graph.root.id;
      validatePlatformName('Connection', address);
      const { db, url } = yield* nodeDatabase({
        id,
        address,
        app,
        application,
        region: o().region,
      });
      // Warm the DB so a consumer's first connect doesn't eat PPG's cold-start
      // (FT-5226). `warm.url` is the same url, so consumers depend on the warm.
      const warm = yield* PgWarm(resourceId(address, 'warmup'), { url }).pipe(
        fromLegacyId(legacyNodeResourceId(app, address, 'warm')),
      );
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
