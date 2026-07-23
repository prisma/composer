/**
 * `resolvePrismaNextConfig` — the config-path → project-facts resolution the
 * lowering does when assembling `PnMigration` props. Loads real
 * `prisma-next.config.ts` fixtures via PN's config loader: the widget
 * fixture (no packs) and the packed fixture (one synthetic pack). No
 * database / Prisma Cloud involved. Plus `packHeadRefHashes`, the pack
 * identity fold the migration resource keys its diff on.
 */
import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import {
  type PnExtensionPack,
  packHeadRefHashes,
  resolveMigrationsDir,
  resolvePrismaNextConfig,
} from '../pn-config.ts';
import {
  GADGET_PACK_HEAD_HASH,
  GADGET_PACK_ID,
  gadgetPack,
} from './fixtures/packed-contract/pack.ts';

const widgetConfig = path.join(
  import.meta.dir,
  'fixtures',
  'widget-contract',
  'source',
  'prisma-next.config.ts',
);

const packedConfig = path.join(
  import.meta.dir,
  'fixtures',
  'packed-contract',
  'source',
  'prisma-next.config.ts',
);

describe('resolvePrismaNextConfig', () => {
  test('resolves the default migrations/ dir relative to the config file', async () => {
    const project = await resolvePrismaNextConfig(widgetConfig);
    // The widget config sets no `migrations.dir`, so PN's default `migrations/`
    // resolves next to the config file (its `source/` directory).
    expect(project.migrationsDir).toBe(path.join(path.dirname(widgetConfig), 'migrations'));
    expect(path.isAbsolute(project.migrationsDir)).toBe(true);
  });

  test('a config with no extension packs yields []', async () => {
    const project = await resolvePrismaNextConfig(widgetConfig);
    expect(project.extensionPacks).toEqual([]);
  });

  test('surfaces declared extension packs with their contract-space heads', async () => {
    const project = await resolvePrismaNextConfig(packedConfig);
    expect(project.extensionPacks.map((p) => p.id)).toEqual([GADGET_PACK_ID]);
    expect(project.extensionPacks[0]?.contractSpace?.headRef.hash).toBe(GADGET_PACK_HEAD_HASH);
  });

  test('resolveMigrationsDir stays the migrationsDir projection of resolvePrismaNextConfig', async () => {
    expect(await resolveMigrationsDir(widgetConfig)).toBe(
      (await resolvePrismaNextConfig(widgetConfig)).migrationsDir,
    );
  });
});

describe('packHeadRefHashes (the migration-resource diff-key fold)', () => {
  const pack = (id: string, hash: string | undefined): PnExtensionPack =>
    ({
      kind: 'extension',
      id,
      familyId: 'sql',
      targetId: 'postgres',
      version: '0.0.1',
      ...(hash !== undefined
        ? {
            contractSpace: {
              contractJson: {},
              migrations: [],
              headRef: { hash, invariants: [] },
            },
          }
        : {}),
      create: () => ({ familyId: 'sql', targetId: 'postgres' }),
    }) as unknown as PnExtensionPack;

  test('one entry per pack, "<id>:<headHash>", sorted by pack id', () => {
    expect(packHeadRefHashes([pack('zeta', 'sha256:z'), pack('alpha', 'sha256:a')])).toEqual([
      'alpha:sha256:a',
      'zeta:sha256:z',
    ]);
  });

  test('a pack upgrade (new head hash) changes its entry', () => {
    expect(packHeadRefHashes([pack('auth', 'sha256:v1')])).not.toEqual(
      packHeadRefHashes([pack('auth', 'sha256:v2')]),
    );
  });

  test('a pack without a contractSpace still contributes its id (head "-")', () => {
    expect(packHeadRefHashes([pack('bare', undefined)])).toEqual(['bare:-']);
  });

  test('no packs → empty key contribution', () => {
    expect(packHeadRefHashes([])).toEqual([]);
  });

  test('the real packed fixture folds to its declared head', () => {
    expect(packHeadRefHashes([gadgetPack])).toEqual([`${GADGET_PACK_ID}:${GADGET_PACK_HEAD_HASH}`]);
  });
});
