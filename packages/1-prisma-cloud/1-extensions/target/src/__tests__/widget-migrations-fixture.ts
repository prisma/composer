/**
 * Authors the widget contract's migration graph through PN's own
 * migration-tools writers (real manifest shape, real `migrationHash`) — the
 * committed artifacts a replay-only deploy replays. Shared by the migrate,
 * resource, and extension-pack suites.
 *
 *   - `authorWidgetInit`: EMPTY → widgetHash (the `CREATE TABLE "Widget"`
 *     DDL) — the baseline a fresh database replays on first deploy.
 *   - `authorWidgetBackfill`: widgetHash → widgetHash, a `data`-class op
 *     carrying `invariantId` — the A→A self-edge only invariant routing can
 *     select — plus a named ref `with-backfill` requiring the invariant.
 */
import * as path from 'node:path';
import { computeMigrationHash } from '@prisma/orm-toolchain/migration-tools/hash';
import { writeMigrationPackage } from '@prisma/orm-toolchain/migration-tools/io';
import { writeRef } from '@prisma/orm-toolchain/migration-tools/refs';
import {
  APP_SPACE_ID,
  spaceMigrationDirectory,
  spaceRefsDirectory,
} from '@prisma/orm-toolchain/migration-tools/spaces';
import { targetStorageHash } from '../prisma-next-migrate.ts';
import widgetContractJson from './fixtures/widget-contract/emitted/contract.json' with {
  type: 'json',
};

export const widgetHash = targetStorageHash(widgetContractJson);
export const BACKFILL_INVARIANT = 'widget-name-backfill';

export async function authorWidgetInit(migrationsDir: string): Promise<void> {
  const appDir = spaceMigrationDirectory(migrationsDir, APP_SPACE_ID);
  const initOps = [
    {
      id: 'table.Widget',
      label: 'Create table "Widget"',
      summary: 'Creates table "Widget"',
      operationClass: 'additive' as const,
      target: {
        id: 'postgres',
        details: { schema: 'public', objectType: 'table', name: 'Widget' },
      },
      precheck: [
        {
          description: 'ensure table "Widget" does not exist',
          sql: 'SELECT (to_regclass($1)) IS NULL AS "result"',
          params: ['"public"."Widget"'],
        },
      ],
      execute: [
        {
          description: 'create table "Widget"',
          sql: 'CREATE TABLE "public"."Widget" (\n  "id" character(36) NOT NULL,\n  "name" text NOT NULL,\n  PRIMARY KEY ("id")\n)',
          params: [],
        },
      ],
      postcheck: [
        {
          description: 'verify table "Widget" exists',
          sql: 'SELECT (to_regclass($1)) IS NOT NULL AS "result"',
          params: ['"public"."Widget"'],
        },
      ],
    },
  ];
  const initMeta = {
    from: null,
    to: widgetHash,
    providedInvariants: [],
    createdAt: '2026-07-12T00:00:00.000Z',
  };
  await writeMigrationPackage(
    path.join(appDir, '20260712T0001_init'),
    { ...initMeta, migrationHash: computeMigrationHash(initMeta, initOps) },
    initOps,
  );
}

export async function authorWidgetBackfill(migrationsDir: string): Promise<void> {
  const appDir = spaceMigrationDirectory(migrationsDir, APP_SPACE_ID);
  const backfillOps = [
    {
      id: `data_migration.${BACKFILL_INVARIANT}`,
      label: `Data transform: ${BACKFILL_INVARIANT}`,
      operationClass: 'data' as const,
      invariantId: BACKFILL_INVARIANT,
      target: { id: 'postgres' },
      precheck: [],
      execute: [
        {
          description: `Run ${BACKFILL_INVARIANT}`,
          sql: 'UPDATE "public"."Widget" SET "name" = btrim("name")',
          params: [],
        },
      ],
      postcheck: [],
    },
  ];
  const backfillMeta = {
    from: widgetHash,
    to: widgetHash,
    providedInvariants: [BACKFILL_INVARIANT],
    createdAt: '2026-07-12T00:00:01.000Z',
  };
  await writeMigrationPackage(
    path.join(appDir, '20260712T0002_backfill'),
    { ...backfillMeta, migrationHash: computeMigrationHash(backfillMeta, backfillOps) },
    backfillOps,
  );

  await writeRef(spaceRefsDirectory(appDir), 'with-backfill', {
    hash: widgetHash,
    invariants: [BACKFILL_INVARIANT],
  });
}
