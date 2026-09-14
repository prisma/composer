/** The `postgres` node kind's descriptor: a Postgres DB (like `postgres`) plus a migration step that brings it to the contract's storageHash (ADR-0022). */

import type { NodeDescriptor } from '@internal/core/config';
import type { Lowering } from '@internal/core/deploy';
import * as Effect from 'effect/Effect';
import { packHeadRefHashes, resolveOrmConfig } from '../orm-config.ts';
import { resolveTargetRef, targetStorageHash } from '../orm-migrate.ts';
import { OrmMigration } from '../orm-migration-resource.ts';
import { isPostgresResourceNode } from '../orm-postgres.ts';
import { PgWarm } from '../pg-warm-resource.ts';
import { runPackPreflight } from '../preflight.ts';
import { type ResolvedCloudOptions, stageDatabase, validateName } from './shared.ts';

/**
 * The migration is a tracked `OrmMigration` Alchemy resource keyed on the
 * target REF identity (hash + sorted invariants): unchanged redeploy is a
 * no-op, a contract or ref-invariant change re-migrates.
 */
export function postgresDescriptor(o: () => ResolvedCloudOptions): NodeDescriptor {
  const lowering: Lowering = ({ id, node, application, graph }) =>
    Effect.gen(function* () {
      validateName(id, 'resource name (from provision id)');
      const { db, url } = yield* stageDatabase({ id, application, region: o().region });

      if (!isPostgresResourceNode(node)) {
        // The registry routes 'postgres'-typed resource nodes here, so this
        // is unreachable — but narrow explicitly rather than cast to read config.
        throw new Error(`postgres lowering received a non-postgres node (${id}).`);
      }
      const contractJson = node.provides.__cmp.contractJson;
      const currentContractHash = targetStorageHash(contractJson);
      const { migrationsDir, extensionPacks } = yield* Effect.promise(() =>
        resolveOrmConfig(node.config),
      );
      // The target REF (node's named `targetRef`, or head by default) is
      // resolved once here so the same identity keys the resource's diff below.
      const ref = yield* Effect.promise(() =>
        resolveTargetRef(migrationsDir, contractJson, node.targetRef),
      );

      // Every required-pack-head edge must name a pack the wired resource's
      // config actually carries, at the required head — checked before the
      // migration step exists, so a bad wiring fails the deploy here rather
      // than leaving a green deploy with a service missing its schema.
      yield* Effect.promise(() => runPackPreflight(graph));

      // Warm the DB first (FT-5226), then migrate against the now-warm url —
      // `warm.url` threads the ordering (PgWarm → OrmMigration).
      const warm = yield* PgWarm(`${id}-warm`, { url });

      // Keyed on the ref identity so a data-only change (same hash, new
      // invariant) still triggers reconcile.
      yield* OrmMigration(`${id}-migrate`, {
        url: warm.url,
        migrationsDir,
        currentContractHash,
        targetHash: ref.hash,
        invariants: [...ref.invariants].sort(),
        packHeadRefHashes: packHeadRefHashes(extensionPacks),
        configPath: node.config,
        ...(node.targetRef !== undefined ? { refName: node.targetRef } : {}),
      });

      // No `url` entity field — same reason as postgres: a connection string is
      // not a public endpoint, and only the descriptor can know that.
      return {
        outputs: { url: warm.url },
        entities: [{ kind: 'postgres-database', id: db.databaseId }],
      };
    });
  return Object.assign(lowering, { kind: 'resource' as const });
}
