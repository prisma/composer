/**
 * The ref-based migration target (review R4) — pure logic, no database.
 *
 *   - `decideMigrationAction`: the full decision matrix, mirroring PN's
 *     verifier ("at target" = hash equal AND ref invariants ⊆ marker
 *     invariants; `dbInit` only when nothing is required that additive-only
 *     synth can't provide).
 *   - `resolveTargetRef`: the default synthesizes the app head from the
 *     emitted contract (PN's own loader behavior — no on-disk app
 *     `refs/head.json` today), an on-disk head wins when present, a named
 *     ref reads `migrations/app/refs/<name>.json`, and a missing named ref
 *     fails loudly.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeRef } from '@prisma-next/migration-tools/refs';
import {
  APP_SPACE_ID,
  spaceMigrationDirectory,
  spaceRefsDirectory,
} from '@prisma-next/migration-tools/spaces';
import {
  decideMigrationAction,
  PnMigrationError,
  resolveTargetRef,
} from '../prisma-next-migrate.ts';

// Real-format hashes — PN's ref writer validates `sha256:<64 hex>`.
const A = `sha256:${'a'.repeat(64)}`;
const B = `sha256:${'b'.repeat(64)}`;

describe('decideMigrationAction — the decision matrix', () => {
  test('marker at ref hash with all invariants → noop', () => {
    expect(
      decideMigrationAction({ storageHash: A, invariants: ['inv-1'] }, { hash: A, invariants: [] }),
    ).toBe('noop');
    expect(
      decideMigrationAction(
        { storageHash: A, invariants: ['inv-1', 'inv-2'] },
        { hash: A, invariants: ['inv-1'] },
      ),
    ).toBe('noop');
  });

  test('marker at ref hash but MISSING an invariant (A→A data-only) → migrate', () => {
    expect(
      decideMigrationAction({ storageHash: A, invariants: [] }, { hash: A, invariants: ['inv-1'] }),
    ).toBe('migrate');
    // A superset requirement with a partial marker is still missing work.
    expect(
      decideMigrationAction(
        { storageHash: A, invariants: ['inv-1'] },
        { hash: A, invariants: ['inv-1', 'inv-2'] },
      ),
    ).toBe('migrate');
  });

  test('fresh DB (no marker) with no required invariants → init', () => {
    expect(decideMigrationAction(null, { hash: A, invariants: [] })).toBe('init');
  });

  test('fresh DB with required invariants → migrate (dbInit never runs data steps)', () => {
    expect(decideMigrationAction(null, { hash: A, invariants: ['inv-1'] })).toBe('migrate');
  });

  test('marker at a different hash → migrate, whatever the invariants say', () => {
    expect(
      decideMigrationAction({ storageHash: B, invariants: [] }, { hash: A, invariants: [] }),
    ).toBe('migrate');
    // Having every required invariant does not compensate for a hash mismatch.
    expect(
      decideMigrationAction(
        { storageHash: B, invariants: ['inv-1'] },
        { hash: A, invariants: ['inv-1'] },
      ),
    ).toBe('migrate');
  });
});

describe('resolveTargetRef', () => {
  const contractJson = { storage: { storageHash: A } };
  const withTempDir = async (fn: (dir: string) => Promise<void>) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-compose-pn-ref-'));
    try {
      await fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  test('default with no on-disk head synthesizes the emitted contract head (zero invariants)', async () => {
    await withTempDir(async (dir) => {
      expect(await resolveTargetRef(dir, contractJson)).toEqual({ hash: A, invariants: [] });
    });
  });

  test('default prefers an on-disk app head.json when one exists', async () => {
    await withTempDir(async (dir) => {
      const refsDir = spaceRefsDirectory(spaceMigrationDirectory(dir, APP_SPACE_ID));
      fs.mkdirSync(refsDir, { recursive: true });
      await writeRef(refsDir, 'head', { hash: B, invariants: ['inv-1'] });
      expect(await resolveTargetRef(dir, contractJson)).toEqual({
        hash: B,
        invariants: ['inv-1'],
      });
    });
  });

  test('a named targetRef reads migrations/app/refs/<name>.json', async () => {
    await withTempDir(async (dir) => {
      const refsDir = spaceRefsDirectory(spaceMigrationDirectory(dir, APP_SPACE_ID));
      fs.mkdirSync(refsDir, { recursive: true });
      await writeRef(refsDir, 'with-backfill', { hash: A, invariants: ['inv-1', 'inv-2'] });
      expect(await resolveTargetRef(dir, contractJson, 'with-backfill')).toEqual({
        hash: A,
        invariants: ['inv-1', 'inv-2'],
      });
    });
  });

  test('a missing named targetRef fails loudly with TARGET_REF_NOT_FOUND', async () => {
    await withTempDir(async (dir) => {
      let thrown: unknown;
      try {
        await resolveTargetRef(dir, contractJson, 'nope');
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(PnMigrationError);
      expect((thrown as PnMigrationError).code).toBe('TARGET_REF_NOT_FOUND');
      expect((thrown as PnMigrationError).message).toContain('nope');
    });
  });
});
