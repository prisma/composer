import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import { Load } from '@makerkit/core';
import { renderStackFile } from '../generate-stack.ts';
import { collectPacks, resolveSinglePack } from '../infer-target.ts';
import { loadEntry } from '../load-entry.ts';

describe('renderStackFile() — a hex root', () => {
  test('renders imports, the name literal, and the bundles dir/entry literals', () => {
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

    expect(content).toContain("import { lower } from '@makerkit/core/deploy';");
    expect(content).toContain('import { fromEnv } from "@makerkit/prisma-cloud/target";');
    expect(content).toContain('import app from "../hex.ts";');
    expect(content).toContain('name: "app"');
    expect(content).toContain('bundles: {');
    expect(content).toContain(
      '"auth": { dir: "/repo/app/hexes/auth/dist/bundle", entry: "server.js" }',
    );
    expect(content).toContain(
      '"storefront": { dir: "/repo/app/hexes/storefront/standalone", entry: "server.js" }',
    );
    // No `stage:` in the generated LowerOptions — core's lower() never reads
    // it; the stage rides on the `alchemy --stage` flag instead.
    expect(content).not.toContain('stage:');
  });

  test('a cwd containing "*/" does not break the generated file (F01)', () => {
    // A legal (if exotic) unix path — a directory literally named "foo*" —
    // yields a cwd containing the two-character sequence "*/". A /** */
    // block-comment header would close early there and emit a syntactically
    // broken file; the header must survive it regardless.
    const cwd = '/repo/examples/foo*/app';
    const content = renderStackFile({
      entryPath: '/repo/examples/foo*/app/hex.ts',
      cwd,
      pack: '@makerkit/prisma-cloud',
      name: 'app',
      assembled: {
        bundles: { app: { dir: '/repo/examples/foo*/app/dist/bundle', entry: 'server.js' } },
      },
    });

    expect(content).toContain(cwd);
    expect(content).not.toContain('/**');
    // The import lines (and everything after the header) must survive intact
    // — a block-comment header would have truncated the file right after the
    // embedded "*/" in the cwd, before these lines are even reached.
    expect(content).toContain("import { lower } from '@makerkit/core/deploy';");
    expect(content).toContain('name: "app"');
  });
});

describe('the generated stack file for a real hex entry (no alchemy run)', () => {
  test('matches the pipeline’s Load → infer target → render sequence', async () => {
    const fixtureDir = path.join(import.meta.dir, 'fixtures');
    const entry = await loadEntry('valid-hex.ts', fixtureDir);

    expect(entry.root.kind).toBe('hex');
    expect(entry.root.name).toBe('fixture-hex');

    const graph = Load(entry.root);
    const pack = resolveSinglePack(collectPacks(graph));
    expect(pack).toBe('test/pack');

    const content = renderStackFile({
      entryPath: entry.path,
      cwd: fixtureDir,
      pack,
      name: entry.root.name,
      assembled: {
        bundles: {
          one: { dir: path.join(fixtureDir, 'one', 'dist', 'bundle'), entry: 'server.js' },
          two: { dir: path.join(fixtureDir, 'two', 'dist', 'bundle'), entry: 'server.js' },
        },
      },
    });

    expect(content).toContain('import { fromEnv } from "test/pack/target";');
    expect(content).toContain('import app from "../valid-hex.ts";');
    expect(content).toContain('name: "fixture-hex"');
    expect(content).toContain(
      `"one": { dir: ${JSON.stringify(path.join(fixtureDir, 'one', 'dist', 'bundle'))}, entry: "server.js" }`,
    );
    expect(content).toContain(
      `"two": { dir: ${JSON.stringify(path.join(fixtureDir, 'two', 'dist', 'bundle'))}, entry: "server.js" }`,
    );
  });
});
