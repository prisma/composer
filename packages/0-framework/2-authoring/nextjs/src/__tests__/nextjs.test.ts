import { describe, expect, test } from 'bun:test';
import nextjs from '../exports/index.ts';

describe('nextjs({ module, appDir })', () => {
  test('returns a plain { extension, type, module, appDir, entry } build adapter descriptor', () => {
    expect(nextjs({ module: 'file:///app/src/service.ts', appDir: '..' })).toEqual({
      extension: '@prisma/composer/nextjs',
      type: 'nextjs',
      module: 'file:///app/src/service.ts',
      appDir: '..',
      entry: 'server.js',
    });
  });

  test('is pure data — calling it twice with the same input yields equal, independent objects', () => {
    const a = nextjs({ module: 'file:///app/src/service.ts', appDir: '..' });
    const b = nextjs({ module: 'file:///app/src/service.ts', appDir: '..' });

    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});
