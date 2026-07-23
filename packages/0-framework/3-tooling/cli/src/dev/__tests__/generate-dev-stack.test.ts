import { describe, expect, test } from 'bun:test';
import { renderDevStackFile } from '../generate-dev-stack.ts';

describe('renderDevStackFile()', () => {
  test('renders the config + app imports (relative), dev: true, localState(), no report', () => {
    const content = renderDevStackFile({
      entryPath: '/repo/app/module.ts',
      cwd: '/repo/app',
      configPath: '/repo/app/prisma-composer.config.ts',
      name: 'app',
      assembled: {
        bundles: {
          web: { dir: '/repo/app/modules/web/dist/bundle', entry: 'server.js' },
        },
      },
    });

    expect(content).toContain("import { lower } from '@prisma/composer/deploy';");
    expect(content).toContain("import { localState } from 'alchemy/State/LocalState';");
    expect(content).toContain('import config from "../../prisma-composer.config.ts";');
    expect(content).toContain('import app from "../../module.ts";');
    expect(content).toContain('lower(app, config, {');
    expect(content).toContain('name: "app"');
    expect(content).toContain('dev: true');
    expect(content).toContain('state: localState()');
    expect(content).toContain(
      '"web": { dir: "/repo/app/modules/web/dist/bundle", entry: "server.js" }',
    );
    // Dev prints its own front door — no report hook in the generated module.
    expect(content).not.toContain('report:');
    expect(content).not.toContain('deploymentReport');
  });

  test('the header comment names the --stage dev reproduction command', () => {
    const content = renderDevStackFile({
      entryPath: '/repo/app/module.ts',
      cwd: '/repo/app',
      configPath: '/repo/app/prisma-composer.config.ts',
      name: 'app',
      assembled: { bundles: {} },
    });

    expect(content).toContain('alchemy deploy .prisma-composer/dev/alchemy.run.ts --stage dev');
  });
});
