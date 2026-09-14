import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { CliStructuredError } from '@internal/foundation/errors';
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

  test('a non-JSX import failure is COMPOSE.ENTRY_UNLOADABLE carrying the entry path and the cause', async () => {
    const error: unknown = await loadEntry(fixture('does-not-exist.ts'), import.meta.dir).catch(
      (e: unknown) => e,
    );

    expect(CliStructuredError.is(error)).toBe(true);
    if (!CliStructuredError.is(error)) throw new Error('unreachable');
    expect(error.code).toBe('COMPOSE.ENTRY_UNLOADABLE');
    expect(error.message).toContain(
      `Failed to import entry module "${fixture('does-not-exist.ts')}"`,
    );
    expect(error.where?.path).toBe(fixture('does-not-exist.ts'));
    expect(error.cause).toBeDefined();
  });

  // Bun's own module loader transforms JSX — this failure is node-specific
  // (the CLI's shebang runtime; see node-compat.test.ts), so it's reproduced
  // by spawning real node against a small standalone driver rather than
  // calling loadEntry() in-process here.
  test('a .tsx transitively imported by the entry gets a tailored error under node', () => {
    const result = spawnSync('node', [fixture('run-load-entry.ts'), fixture('jsx-in-graph.ts')], {
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(fixture('jsx-in-graph.tsx'));
    expect(result.stderr).toContain("node's own module loader");
    expect(result.stderr).toContain('JSX transform');
    expect(result.stderr).toContain('examples/email/scripts/build.ts');
    // where.path carries the entry (ruling on `where`: the natural path).
    expect(result.stderr).toContain(`Where: ${fixture('jsx-in-graph.ts')}`);
  }, 15000);

  // The resolve hook is node-specific (Bun resolves .js→.ts natively).
  // These tests spawn real node so the hook registration path is exercised.

  test('a .js-extension import resolves to the .ts source under node', () => {
    const result = spawnSync(
      'node',
      [fixture('run-load-entry.ts'), fixture('entry-js-ext-import.ts')],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(0);
  }, 15000);

  test('an extensionless import resolves to the .ts source under node', () => {
    const result = spawnSync(
      'node',
      [fixture('run-load-entry.ts'), fixture('entry-no-ext-import.ts')],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(0);
  }, 15000);

  test('a .mjs-extension import resolves to the .mts source under node', () => {
    const result = spawnSync(
      'node',
      [fixture('run-load-entry.ts'), fixture('entry-mjs-ext-import.ts')],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(0);
  }, 15000);

  test('a .cjs-extension import resolves to the .cts source under node', () => {
    const result = spawnSync(
      'node',
      [fixture('run-load-entry.ts'), fixture('entry-cjs-ext-import.ts')],
      { encoding: 'utf8' },
    );

    // The hook resolved .cjs → .cts; resolution succeeded, but the fixture's
    // export is not a Composer node, so the failure is ENTRY_EXPORT_INVALID.
    expect(result.stderr).not.toContain('Cannot find module');
    expect(result.stderr).toContain('must default-export a node');
  }, 15000);

  test('a genuinely missing relative import still fails with the original error under node', () => {
    const result = spawnSync(
      'node',
      [fixture('run-load-entry.ts'), fixture('entry-truly-missing-import.ts')],
      { encoding: 'utf8' },
    );

    expect(result.status).not.toBe(0);
    // The hook exhausted all candidates; the original ERR_MODULE_NOT_FOUND is re-thrown.
    expect(result.stderr).toContain('truly-missing');
  }, 15000);

  // Bun resolves .js→.ts natively — load in-process to confirm the hook is a
  // no-op (nothing is registered) and the imports still work.
  test('a .js-extension import loads correctly in-process under bun', async () => {
    const entry = await loadEntry(fixture('entry-js-ext-import.ts'), import.meta.dir);
    expect(entry.root.kind).toBe('service');
  });

  test('an extensionless import loads correctly in-process under bun', async () => {
    const entry = await loadEntry(fixture('entry-no-ext-import.ts'), import.meta.dir);
    expect(entry.root.kind).toBe('service');
  });
});
