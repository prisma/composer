/** The `prisma-next` node kind's descriptor: a Postgres DB (like `postgres`) plus a migration step that brings it to the contract's storageHash (ADR-0022). */

import type { NodeDescriptor } from '@internal/core/config';
import type { Lowering } from '@internal/core/deploy';
import * as Output from 'alchemy/Output';
import * as Prisma from 'alchemy/Prisma';
import * as Effect from 'effect/Effect';
import * as Redacted from 'effect/Redacted';
import { PgWarm } from '../pg-warm-resource.ts';
import { packHeadRefHashes, resolvePrismaNextConfig } from '../pn-config.ts';
import { PnMigration } from '../pn-migration-resource.ts';
import { runPackPreflight } from '../preflight.ts';
import { isPnPostgresResourceNode } from '../prisma-next.ts';
import { resolveTargetRef } from '../prisma-next-migrate.ts';
import {
  cloudApplicationOf,
  DEFAULT_REGION,
  projectIdOf,
  type ResolvedCloudOptions,
  validateName,
} from './shared.ts';

/**
 * The migration is a tracked `PnMigration` Alchemy resource keyed on the
 * target REF identity (hash + sorted invariants): unchanged redeploy is a
 * no-op, a contract or ref-invariant change re-migrates.
 */
export function prismaNextDescriptor(o: () => ResolvedCloudOptions): NodeDescriptor {
  const lowering: Lowering = ({ id, node, application, graph }) =>
    Effect.gen(function* () {
      validateName(id, 'resource name (from provision id)');
      const branchId = cloudApplicationOf(application).branchId;
      // Same create rule as descriptors/postgres.ts: an explicit name cannot
      // combine with branch attachment at create, so a named stage omits the
      // name and carries the branchId in props (created attached, reconciled
      // attached).
      const db = yield* Prisma.Database(`${id}-db`, {
        project: projectIdOf(application),
        region: o().region ?? DEFAULT_REGION,
        ...(branchId !== undefined ? { branchId } : { name: id }),
      });
      const conn = yield* Prisma.Connection(`${id}-conn`, { database: db, name: id });
      // Direct, not pooled — PgWarm and PnMigration below depend on it, and
      // upstream's `databaseUrl` is pooled-first.
      const url = Output.map(conn.directConnectionString, (value) => {
        if (value === undefined) {
          throw new Error(
            `prisma-cloud: connection "${id}-conn" returned no direct connection string.`,
          );
        }
        return Redacted.value(value);
      });

      if (!isPnPostgresResourceNode(node)) {
        // The registry routes 'prisma-next'-typed resource nodes here, so this
        // is unreachable — but narrow explicitly rather than cast to read config.
        throw new Error(`prisma-next lowering received a non-prisma-next node (${id}).`);
      }
      const contractJson = node.provides.__cmp.contractJson;
      const { migrationsDir, extensionPacks } = yield* Effect.promise(() =>
        resolvePrismaNextConfig(node.config),
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
