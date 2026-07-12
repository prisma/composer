import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import { loadEntry } from '../load-entry.ts';

const fixture = (name: string) => path.join(import.meta.dir, 'fixtures', name);

describe('loadEntry()', () => {
  test('accepts a service default export', async () => {
    const entry = await loadEntry(fixture('valid-service.ts'), import.meta.dir);
    expect(entry.root.kind).toBe('service');
    expect(entry.path).toBe(fixture('valid-service.ts'));
  });

  test('accepts a module default export', async () => {
    const entry = await loadEntry(fixture('valid-module.ts'), import.meta.dir);
    expect(entry.root.kind).toBe('module');
  });

  test('rejects a plain-object default export — names what the module must export', async () => {
    await expect(loadEntry(fixture('non-node-export.ts'), import.meta.dir)).rejects.toThrow(
      /must default-export a node \(a service or a module\)/,
    );
  });

  test('rejects a resource default export — a resource is not a valid root', async () => {
    await expect(loadEntry(fixture('resource-export.ts'), import.meta.dir)).rejects.toThrow(
      /must default-export a node \(a service or a module\)/,
    );
  });

  test('resolves the entry path against the given cwd', async () => {
    const entry = await loadEntry('fixtures/valid-service.ts', import.meta.dir);
    expect(entry.path).toBe(fixture('valid-service.ts'));
  });
});
