import { describe, expect, test } from 'bun:test';
import { INLINE_EVERYTHING_EXCEPT_RUNTIME_BUILTINS } from '../wrapper-inline.ts';

const matches = (specifier: string): boolean =>
  INLINE_EVERYTHING_EXCEPT_RUNTIME_BUILTINS.some((p) => p.test(specifier));

describe('INLINE_EVERYTHING_EXCEPT_RUNTIME_BUILTINS', () => {
  test('runtime modules stay external: bun, bun:*, node:*', () => {
    expect(matches('bun')).toBe(false);
    expect(matches('bun:sqlite')).toBe(false);
    expect(matches('bun:test')).toBe(false);
    expect(matches('node:fs')).toBe(false);
    expect(matches('node:path')).toBe(false);
  });

  test('everything else inlines: bare deps, scoped packages, subpaths', () => {
    expect(matches('pg')).toBe(true);
    expect(matches('arktype')).toBe(true);
    expect(matches('@prisma/compose')).toBe(true);
    expect(matches('@storefront-auth/auth/contract')).toBe(true);
    // A package whose name merely STARTS with "bun" is not a runtime module.
    expect(matches('bunyan')).toBe(true);
  });
});
