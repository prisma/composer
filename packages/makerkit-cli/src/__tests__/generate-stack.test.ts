import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import { Load } from '@makerkit/core';
import { renderStackFile } from '../generate-stack.ts';
import { collectPacks, resolveSinglePack } from '../infer-target.ts';
import { loadEntry } from '../load-entry.ts';

describe('renderStackFile() — a service root', () => {
  test('renders imports, the name literal, and the bundle dir/entry literals', () => {
    const content = renderStackFile({
      entryPath: '/repo/examples/makerkit-hello/src/service.ts',
      cwd: '/repo/examples/makerkit-hello',
      pack: '@makerkit/prisma-cloud',
      name: 'hello',
      assembled: {
        bundle: { dir: '/repo/examples/makerkit-hello/dist/bundle', entry: 'server.js' },
      },
    });

    expect(content).toContain("import { lower } from '@makerkit/core/deploy';");
    expect(content).toContain('import { fromEnv } from "@makerkit/prisma-cloud/target";');
    expect(content).toContain('import app from "../src/service.ts";');
    expect(content).toContain('name: "hello"');
    expect(content).toContain(
      'bundle: { dir: "/repo/examples/makerkit-hello/dist/bundle", entry: "server.js" }',
    );
    expect(content).not.toContain('bundles:');
    // No `stage:` in the generated LowerOptions — core's lower() never reads
    // it; the stage rides on the `alchemy --stage` flag instead.
    expect(content).not.toContain('stage:');
  });

  test('renders `bundles` (keyed by provision id) for a hex root, not `bundle`', () => {
    const content = renderStackFile({
      entryPath: '/repo/app/hex.ts',
      cwd: '/repo/app',
      pack: '@makerkit/prisma-cloud',
      name: 'app',
      assembled: {
        bundles: {
          auth: { dir: '/repo/app/hexes/auth/dist/bundle', entry: 'server.js' },
          storefront: { dir: '/repo/app/hexes/storefront/standalone', entry: 'server.js' },
        },
      },
    });

    expect(content).not.toContain('bundle:');
    expect(content).toContain('bundles: {');
    expect(content).toContain(
      '"auth": { dir: "/repo/app/hexes/auth/dist/bundle", entry: "server.js" }',
    );
    expect(content).toContain(
      '"storefront": { dir: "/repo/app/hexes/storefront/standalone", entry: "server.js" }',
    );
  });
});

describe('the generated stack file for examples/makerkit-hello (no alchemy run)', () => {
  test('matches the semantics of the deleted hand-written alchemy.run.ts', async () => {
    const helloDir = path.resolve(
      import.meta.dir,
      '..',
      '..',
      '..',
      '..',
      'examples',
      'makerkit-hello',
    );
    const entry = await loadEntry(path.join('src', 'service.ts'), helloDir);

    expect(entry.root.kind).toBe('service');
    expect(entry.root.name).toBe('hello');

    const graph = Load(entry.root);
    const pack = resolveSinglePack(collectPacks(graph));
    expect(pack).toBe('@makerkit/prisma-cloud');

    // A real `makerkit deploy` run has cwd == the package dir (the example's
    // own "deploy" script runs from here) — no anchor discovery involved.
    const content = renderStackFile({
      entryPath: entry.path,
      cwd: helloDir,
      pack,
      name: entry.root.name,
      assembled: { bundle: { dir: path.join(helloDir, 'dist', 'bundle'), entry: 'server.js' } },
    });

    // Same inputs the deleted alchemy.run.ts hand-wrote to lower():
    // lower(service, prismaCloud({ workspaceId }), { name: 'makerkit-hello', bundle: { dir: dist/bundle, entry: server.js } }) —
    // modulo the app import (fromEnv() replaces the inline prismaCloud() construction, ADR-0003).
    expect(content).toContain('import { fromEnv } from "@makerkit/prisma-cloud/target";');
    expect(content).toContain('import app from "../src/service.ts";');
    expect(content).toContain('name: "hello"');
    expect(content).toContain(
      `bundle: { dir: ${JSON.stringify(path.join(helloDir, 'dist', 'bundle'))}, entry: "server.js" }`,
    );
  });
});
