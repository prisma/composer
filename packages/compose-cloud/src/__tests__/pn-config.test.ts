/**
 * `resolveMigrationsDir` — the config-path → migrations-dir resolution the
 * lowering does when assembling `PnMigration` props (slice 2 D2). Loads a real
 * `prisma-next.config.ts` (the widget fixture) via PN's config loader and
 * applies PN's convention: `migrations/` relative to the config file, unless
 * `migrations.dir` overrides it. No database / Prisma Cloud involved.
 */
import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import { resolveMigrationsDir } from '../pn-config.ts';

const widgetConfig = path.join(
  import.meta.dir,
  'fixtures',
  'widget-contract',
  'source',
  'prisma-next.config.ts',
);

describe('resolveMigrationsDir', () => {
  test('resolves the default migrations/ dir relative to the config file', async () => {
    const dir = await resolveMigrationsDir(widgetConfig);
    // The widget config sets no `migrations.dir`, so PN's default `migrations/`
    // resolves next to the config file (its `source/` directory).
    expect(dir).toBe(path.join(path.dirname(widgetConfig), 'migrations'));
    expect(path.isAbsolute(dir)).toBe(true);
  });
});
