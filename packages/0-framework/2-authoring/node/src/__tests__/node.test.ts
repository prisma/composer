import { describe, expect, test } from 'bun:test';
import node from '../exports/index.ts';

describe('node({ module, entry }) — the single-file form', () => {
  test('returns a plain { extension, type, module, entry } build adapter descriptor', () => {
    expect(node({ module: 'file:///app/src/service.ts', entry: 'server.js' })).toEqual({
      extension: '@prisma/composer/node',
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

  test("omits the dir key entirely, rather than carrying an undefined — dir's presence is what selects the directory form", () => {
    expect('dir' in node({ module: 'file:///app/src/service.ts', entry: 'server.js' })).toBe(false);
  });
});

describe('node({ module, dir, entry }) — the directory form', () => {
  test('returns the descriptor with dir alongside entry', () => {
    expect(
      node({ module: 'file:///app/src/service.ts', dir: '../dist/server', entry: 'start.js' }),
    ).toEqual({
      extension: '@prisma/composer/node',
      type: 'node',
      module: 'file:///app/src/service.ts',
      dir: '../dist/server',
      entry: 'start.js',
    });
  });

  test('carries dir and a nested entry through unmodified — both resolve at assemble time, neither is rewritten', () => {
    const descriptor = node({
      module: 'file:///app/src/service.ts',
      dir: '../dist/server',
      entry: 'nested/start.js',
    });

    expect(descriptor.dir).toBe('../dist/server');
    expect(descriptor.entry).toBe('nested/start.js');
  });
});

describe('the two forms are exclusive at the type level', () => {
  test('dir without entry does not type-check — the author must name what boots inside the tree', () => {
    const module = 'file:///app/src/service.ts';
    // @ts-expect-error — the directory form requires entry. Checked by `tsc --noEmit`,
    // which covers this directory: the directive fails the build if the call ever compiles.
    const descriptor = node({ module, dir: '../dist/server' });

    // Defeating the type leaves the descriptor with nothing to boot.
    expect(descriptor.entry).toBeUndefined();
  });
});
