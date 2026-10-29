import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import { renderDevStackFile } from '../generate-dev-stack.ts';

describe('renderDevStackFile()', () => {
  test('renders the config + app imports (relative), resolved dev providers, devState(), no report', () => {
    const content = renderDevStackFile({
      entryPath: '/repo/app/module.ts',
      cwd: '/repo/app',
      configFile: '/repo/app/prisma.config.ts',
      name: 'app',
      environment: 'dev',
      assembled: {
        devServers: {},
        bundles: {
          web: { dir: '/repo/app/modules/web/dist/bundle', entry: 'server.js' },
        },
      },
    });

    expect(content).toContain("import { lower } from '@prisma/composer/deploy';");
    expect(content).toContain("import { deserializeContainers } from '@prisma/composer/config';");
    expect(content).toContain(
      "import { devEnvironmentDir, devState, localTargetProviders, resolveLocalTargets } from '@prisma/composer/local-target';",
    );
    // alchemy is Composer's dependency, not the app's: under pnpm the app
    // cannot import it, so the stack file reaches it through Composer.
    expect(content).not.toContain("from 'alchemy");
    expect(content).toContain('import prismaConfig from "../../../prisma.config.ts";');
    expect(content).toContain('const config = prismaConfig.composer;');
    expect(content).toContain('import app from "../../../module.ts";');
    // The one orchestration point (spec § 3 REVISED): containers
    // deserialized, `localTarget` thunks resolved by top-level await,
    // providers + state passed explicitly — and no `dev` flag, which no
    // longer exists on LowerOptions.
    expect(content).toContain(
      'const containers = deserializeContainers(config.extensions, process.env);',
    );
    expect(content).toContain('const resolved = await resolveLocalTargets(config);');
    expect(content).toContain('const devDir = path.join(process.cwd(), devEnvironmentDir("dev"));');
    expect(content).toContain('lower(app, config, {');
    expect(content).toContain('name: "app"');
    expect(content).toContain('providers: localTargetProviders(resolved, containers, devDir)');
    expect(content).toContain('state: devState()');
    expect(content).not.toContain('dev: true');
    expect(content).toContain(
      '"web": { dir: "/repo/app/modules/web/dist/bundle", entry: "server.js" }',
    );
    // Dev prints its own front door — no report hook in the generated module.
    expect(content).not.toContain('report:');
    expect(content).not.toContain('deploymentReport');
  });

  test('the header comment names the command Composer starts, at the Alchemy stage named by the environment', () => {
    const content = renderDevStackFile({
      entryPath: '/repo/app/module.ts',
      cwd: '/repo/app',
      configFile: '/repo/app/prisma.config.ts',
      name: 'app',
      environment: 'feature/x',
      assembled: { devServers: {}, bundles: {} },
    });

    expect(content).toContain(
      `<node> <bin of the alchemy @prisma/composer depends on> deploy ${path.join('.prisma-composer', 'dev', 'feature%2Fx', 'alchemy.run.ts')} --yes --stage feature/x`,
    );
    expect(content).toContain(
      'const devDir = path.join(process.cwd(), devEnvironmentDir("feature/x"));',
    );
    expect(content).toContain('import app from "../../../module.ts";');
  });
});

describe('renderDevStackFile() — the environment', () => {
  test('passes the environment to lower(), so Load resolves values over environment.name', () => {
    const content = renderDevStackFile({
      entryPath: '/repo/app/module.ts',
      cwd: '/repo/app',
      configFile: '/repo/app/prisma.config.ts',
      name: 'app',
      environment: 'test',
      assembled: { devServers: {}, bundles: {} },
    });

    expect(content).toContain('  name: "app",\n  environment: "test",\n');
  });
});

describe('renderDevStackFile() — services with dev servers (ADR-0056)', () => {
  const input = (devServers: Record<string, { cwd: string; display: string }>) => ({
    entryPath: '/repo/app/module.ts',
    cwd: '/repo/app',
    configFile: '/repo/app/prisma.config.ts',
    name: 'app',
    environment: 'dev',
    assembled: {
      bundles: { api: { dir: '/repo/app/api/dist/bundle', entry: 'server.js' } },
      devServers: Object.fromEntries(
        Object.entries(devServers).map(([address, s]) => [address, { ...s, argv: () => [] }]),
      ),
    },
  });

  test('lists them as unassembled, beside the bundles of the assembled services', () => {
    const content = renderDevStackFile(
      input({ web: { cwd: '/repo/app/web', display: 'next dev' } }),
    );

    expect(content).toContain(
      '    "api": { dir: "/repo/app/api/dist/bundle", entry: "server.js" },',
    );
    expect(content).toContain('  unassembled: ["web"],');
  });

  test('renders no unassembled list when no service runs a dev server', () => {
    expect(renderDevStackFile(input({}))).not.toContain('unassembled');
  });
});
