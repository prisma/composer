import { describe, expect, test } from 'bun:test';
import nextjs from '../index.ts';

describe('nextjs({ module, standalone, entry })', () => {
  test('returns a plain { extension, type, module, standalone, entry } build adapter descriptor', () => {
    expect(
      nextjs({
        module: 'file:///app/src/service.ts',
        standalone: '../.next/standalone',
        entry: 'apps/web/server.js',
      }),
    ).toEqual({
      extension: '@prisma/compose/nextjs',
      type: 'nextjs',
      module: 'file:///app/src/service.ts',
      standalone: '../.next/standalone',
      entry: 'apps/web/server.js',
    });
  });

  test('carries the entry through unmodified — the bootable server path relative to the standalone root', () => {
    expect(
      nextjs({
        module: 'file:///app/src/service.ts',
        standalone: '../.next/standalone',
        entry: 'apps/web/server.js',
      }).entry,
    ).toBe('apps/web/server.js');
  });

  test('is pure data — calling it twice with the same input yields equal, independent objects', () => {
    const a = nextjs({
      module: 'file:///app/src/service.ts',
      standalone: '..',
      entry: 'server.js',
    });
    const b = nextjs({
      module: 'file:///app/src/service.ts',
      standalone: '..',
      entry: 'server.js',
    });

    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});
