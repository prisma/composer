import { describe, expect, test } from 'bun:test';
import nextjs from '../index.ts';

describe('nextjs({ module, appDir, entry })', () => {
  test('returns a plain { extension, type, module, appDir, entry } build adapter descriptor', () => {
    expect(
      nextjs({ module: 'file:///app/src/service.ts', appDir: '..', entry: 'server.js' }),
    ).toEqual({
      extension: '@prisma/compose/nextjs',
      type: 'nextjs',
      module: 'file:///app/src/service.ts',
      appDir: '..',
      entry: 'server.js',
    });
  });

  test("carries the entry through unmodified — Next's standalone server.js, resolved inside the assembled standalone dir", () => {
    expect(
      nextjs({
        module: 'file:///app/src/service.ts',
        appDir: '..',
        entry: '.next/standalone/server.js',
      }).entry,
    ).toBe('.next/standalone/server.js');
  });

  test('is pure data — calling it twice with the same input yields equal, independent objects', () => {
    const a = nextjs({ module: 'file:///app/src/service.ts', appDir: '..', entry: 'server.js' });
    const b = nextjs({ module: 'file:///app/src/service.ts', appDir: '..', entry: 'server.js' });

    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});
