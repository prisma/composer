import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import { Load, service, system } from '@prisma/app';
import { renderStackFile } from '../generate-stack.ts';
import { loadEntry } from '../load-entry.ts';

describe('renderStackFile() — a system root', () => {
  test('renders the config + app imports (relative), the name literal, and the bundles dir/entry literals', () => {
    const content = renderStackFile({
      entryPath: '/repo/app/system.ts',
      cwd: '/repo/app',
      configPath: '/repo/app/prisma-app.config.ts',
      name: 'app',
      assembled: {
        bundles: {
          auth: { dir: '/repo/app/systems/auth/dist/bundle', entry: 'server.js' },
          storefront: { dir: '/repo/app/systems/storefront/standalone', entry: 'server.js' },
        },
      },
    });

    expect(content).toContain("import { lower } from '@prisma/app/deploy';");
    expect(content).toContain('import config from "../prisma-app.config.ts";');
    expect(content).toContain('import app from "../system.ts";');
    expect(content).toContain('lower(app, config, {');
    expect(content).toContain('name: "app"');
    expect(content).toContain('bundles: {');
    expect(content).toContain(
      '"auth": { dir: "/repo/app/systems/auth/dist/bundle", entry: "server.js" }',
    );
    expect(content).toContain(
      '"storefront": { dir: "/repo/app/systems/storefront/standalone", entry: "server.js" }',
    );
    // No `stage:` in the generated LowerOptions — core's lower() never reads
    // it; the stage rides on the `alchemy --stage` flag instead.
    expect(content).not.toContain('stage:');
  });

  test('a config discovered ABOVE the app dir renders with the deeper relative path', () => {
    const content = renderStackFile({
      entryPath: '/repo/apps/shop/system.ts',
      cwd: '/repo/apps/shop',
      configPath: '/repo/prisma-app.config.ts',
      name: 'app',
      assembled: { bundles: { app: { dir: '/repo/apps/shop/dist', entry: 'server.js' } } },
    });

    expect(content).toContain('import config from "../../../prisma-app.config.ts";');
  });

  test('a cwd containing "*/" does not break the generated file (F01)', () => {
    // A legal (if exotic) unix path — a directory literally named "foo*" —
    // yields a cwd containing the two-character sequence "*/". A /** */
    // block-comment header would close early there and emit a syntactically
    // broken file; the header must survive it regardless.
    const cwd = '/repo/examples/foo*/app';
    const content = renderStackFile({
      entryPath: '/repo/examples/foo*/app/system.ts',
      cwd,
      configPath: '/repo/examples/foo*/app/prisma-app.config.ts',
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
    expect(content).toContain("import { lower } from '@prisma/app/deploy';");
    expect(content).toContain('name: "app"');
  });
});

describe('the generated stack file for a real system entry (no alchemy run)', () => {
  test('matches the pipeline’s Load → render sequence', async () => {
    const fixtureDir = path.join(import.meta.dir, 'fixtures');
    const entry = await loadEntry('valid-system.ts', fixtureDir);

    expect(entry.root.kind).toBe('system');
    expect(entry.root.name).toBe('fixture-system');

    Load(entry.root);

    const content = renderStackFile({
      entryPath: entry.path,
      cwd: fixtureDir,
      configPath: path.join(fixtureDir, 'prisma-app.config.ts'),
      name: entry.root.name,
      assembled: {
        bundles: {
          one: { dir: path.join(fixtureDir, 'one', 'dist', 'bundle'), entry: 'server.js' },
          two: { dir: path.join(fixtureDir, 'two', 'dist', 'bundle'), entry: 'server.js' },
        },
      },
    });

    expect(content).toContain('import config from "../prisma-app.config.ts";');
    expect(content).toContain('import app from "../valid-system.ts";');
    expect(content).toContain('name: "fixture-system"');
    expect(content).toContain(
      `"one": { dir: ${JSON.stringify(path.join(fixtureDir, 'one', 'dist', 'bundle'))}, entry: "server.js" }`,
    );
    expect(content).toContain(
      `"two": { dir: ${JSON.stringify(path.join(fixtureDir, 'two', 'dist', 'bundle'))}, entry: "server.js" }`,
    );
    expect(content).not.toContain('bundle:');
  });
});

describe('nested-system proof (H1: system-composition) — dotted addresses survive renderStackFile', () => {
  test('a service provisioned by a system nested inside another system renders with its dotted address as the bundle key', () => {
    const innerService = () =>
      service({
        name: 'auth-api',
        extension: 'test/pack',
        type: 'fixture/service',
        inputs: {},
        params: {},
        build: {
          extension: 'test/build',
          type: 'node',
          module: 'file:///fixtures/auth/service.ts',
          entry: 'server.js',
        },
      });
    const inner = system('auth', {}, ({ provision }) => {
      provision('api', innerService());
      return {};
    });
    const root = system('shop', {}, ({ provision }) => {
      provision('auth', inner);
      return {};
    });
    const graph = Load(root);

    // The full hierarchical address (H1) — not the bare provision id "api".
    expect(graph.nodes.some((n) => n.id === 'auth.api')).toBe(true);

    const content = renderStackFile({
      entryPath: '/repo/app/system.ts',
      cwd: '/repo/app',
      configPath: '/repo/app/prisma-app.config.ts',
      name: 'shop',
      assembled: { bundles: { 'auth.api': { dir: '/bundles/auth-api', entry: 'server.js' } } },
    });

    // The dotted key survives intact into the generated stack source, quoted
    // as a plain string literal — a bare property key can't spell a ".".
    expect(content).toContain('"auth.api": { dir: "/bundles/auth-api", entry: "server.js" }');
  });
});
