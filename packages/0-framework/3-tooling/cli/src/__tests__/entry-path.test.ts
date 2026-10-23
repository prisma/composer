import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import type { PrismaAppConfig } from '@internal/core/config';
import { type ComposerConfigSource, checkComposerConfig } from '../composer-config.ts';
import { resolveEntryPath } from '../pipeline.ts';

const descriptors: PrismaAppConfig = {
  extensions: [],
  state: { extension: 'fixture-state', create: () => ({}) as never },
};

const source = (entry: string | undefined): ComposerConfigSource => ({
  value: entry === undefined ? descriptors : { ...descriptors, entry },
  file: '/repo/apps/shop/prisma.config.ts',
});

describe('resolveEntryPath', () => {
  test("the config's entry resolves against the directory of the file that declares it", () => {
    expect(resolveEntryPath(undefined, source('./module.ts'), '/somewhere/else')).toBe(
      '/repo/apps/shop/module.ts',
    );
  });

  test('an override resolves against cwd and wins over the config', () => {
    expect(resolveEntryPath('other.ts', source('./module.ts'), '/work')).toBe('/work/other.ts');
  });

  test('the result is absolute, whatever the inputs', () => {
    expect(path.isAbsolute(resolveEntryPath('rel/x.ts', source(undefined), 'cwd-relative'))).toBe(
      true,
    );
  });

  test('with neither, it fails with CONFIG.ENTRY_MISSING naming both ways to set one', () => {
    expect(() => resolveEntryPath(undefined, source(undefined), '/work')).toThrow(
      expect.objectContaining({
        code: 'CONFIG.ENTRY_MISSING',
        fix: "Set `entry: './module.ts'` in the `composer` section of prisma.config.ts, or pass `--entry <path>`.",
      }),
    );
  });
});

describe('the section check on `entry`', () => {
  test('accepts a non-empty string and returns it', () => {
    const checked = checkComposerConfig({ ...descriptors, entry: './module.ts' }, '/nowhere/p.ts');
    expect(checked.ok && checked.value.entry).toBe('./module.ts');
  });

  test('accepts a section without it', () => {
    expect(checkComposerConfig(descriptors, '/nowhere/p.ts').ok).toBe(true);
  });

  test('refuses an empty string or a non-string', () => {
    for (const entry of ['', 42, ['./module.ts']]) {
      const checked = checkComposerConfig({ ...descriptors, entry }, '/nowhere/p.ts');
      expect(checked.ok).toBe(false);
      if (!checked.ok) {
        expect(checked.findings[0]).toMatchObject({ code: 'CONFIG.FIELD_INVALID', field: 'entry' });
      }
    }
  });
});
