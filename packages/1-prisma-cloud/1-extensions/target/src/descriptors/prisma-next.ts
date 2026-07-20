/** The `prisma-next` node kind's descriptor: a Postgres DB (like `postgres`) plus a migration step that brings it to the contract's storageHash (ADR-0022). */

import type { NodeDescriptor } from '@internal/core/config';
import type { Lowering } from '@internal/core/deploy';
import * as Prisma from '@internal/lowering';
import * as Output from 'alchemy/Output';
import * as Effect from 'effect/Effect';
import * as Redacted from 'effect/Redacted';
import { isPnPostgresResourceNode } from '../exports/prisma-next.ts';
import { PgWarm } from '../pg-warm-resource.ts';
import { resolveMigrationsDir } from '../pn-config.ts';
import { PnMigration } from '../pn-migration-resource.ts';
import { resolveTargetRef } from '../prisma-next-migrate.ts';
import { DEFAULT_REGION, projectIdOf, type ResolvedCloudOptions, validateName } from './shared.ts';

/**
 * The migration is a tracked `PnMigration` Alchemy resource keyed on the
 * target REF identity (hash + sorted invariants): unchanged redeploy is a
 * no-op, a contract or ref-invariant change re-migrates.
 */
export function prismaNextDescriptor(o: ResolvedCloudOptions): NodeDescriptor {
  const lowering: Lowering = ({ id, node, application }) =>
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

      if (!isPnPostgresResourceNode(node)) {
        // The registry routes 'prisma-next'-typed resource nodes here, so this
        // is unreachable — but narrow explicitly rather than cast to read config.
        throw new Error(`prisma-next lowering received a non-prisma-next node (${id}).`);
      }
      const contractJson = node.provides.__cmp.contractJson;
      const migrationsDir = yield* Effect.promise(() => resolveMigrationsDir(node.config));
      // The target REF (node's named `targetRef`, or head by default) is
      // resolved once here so the same identity keys the resource's diff below.
      const ref = yield* Effect.promise(() =>
        resolveTargetRef(migrationsDir, contractJson, node.targetRef),
      );

      // Warm the DB first (FT-5226), then migrate against the now-warm url —
      // `warm.url` threads the ordering (PgWarm → PnMigration).
      const warm = yield* PgWarm(`${id}-warm`, { url });

      // Keyed on the ref identity so a data-only change (same hash, new
      // invariant) still triggers reconcile.
      yield* PnMigration(`${id}-migrate`, {
        url: warm.url,
        contractJson,
        migrationsDir,
        targetHash: ref.hash,
        invariants: [...ref.invariants].sort(),
        ...(node.targetRef !== undefined ? { refName: node.targetRef } : {}),
      });

      // No `url` entity field — same reason as postgres: a connection string is
      // not a public endpoint, and only the descriptor can know that.
      return {
        outputs: { url: warm.url },
        entities: [{ kind: 'postgres-database', id: db.id }],
      };
    });
  return Object.assign(lowering, { kind: 'resource' as const });
}
