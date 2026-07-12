import { describe, expect, test } from 'bun:test';
import node from '../index.ts';

describe('node({ module, entry })', () => {
  test('returns a plain { extension, type, module, entry } build adapter descriptor', () => {
    expect(node({ module: 'file:///app/src/service.ts', entry: 'server.js' })).toEqual({
      extension: '@prisma/compose-node',
      type: 'node',
      module: 'file:///app/src/service.ts',
      entry: 'server.js',
    });
  });

  test('carries the entry through unmodified — resolved relative to dirname(module) at assemble time, never rewritten', () => {
    expect(node({ module: 'file:///app/src/service.ts', entry: '../dist/server.js' }).entry).toBe(
      '../dist/server.js',
    );
  });

  test('is pure data — calling it twice with the same input yields equal, independent objects', () => {
    const a = node({ module: 'file:///app/src/service.ts', entry: 'server.js' });
    const b = node({ module: 'file:///app/src/service.ts', entry: 'server.js' });

    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});
