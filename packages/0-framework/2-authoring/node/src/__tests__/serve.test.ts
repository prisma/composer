import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { nodeBuild, serve } from '../exports/control.ts';
import node from '../exports/index.ts';

// Built from a path so it carries a drive letter on Windows, where a bare
// `file:///app/...` URL is not a valid file path.
const module = pathToFileURL(path.resolve('/app/api/src/service.ts')).href;

describe('node({ dev }) (ADR-0056)', () => {
  test('carries dev through as given', () => {
    expect(
      node({ module, entry: '../dist/server.mjs', dev: ['bun', '--watch', 'server.ts'] }),
    ).toEqual({
      extension: '@prisma/composer/node',
      type: 'node',
      module,
      entry: '../dist/server.mjs',
      dev: ['bun', '--watch', 'server.ts'],
    });
  });

  test('omits the dev key when the author does not set it', () => {
    expect('dev' in node({ module, entry: 'server.js' })).toBe(false);
  });

  test('an empty dev is rejected when the service is declared', () => {
    expect(() => node({ module, entry: 'server.js', dev: [] })).toThrow(
      'node(): `dev` must name a command',
    );
  });
});

describe('serve() — the node dev command (ADR-0056)', () => {
  test('without dev there is no dev server: the service runs its artifact', async () => {
    expect(await serve({ build: node({ module, entry: 'server.js' }), address: 'api' })).toBe(
      undefined,
    );
  });

  test("runs the author's command verbatim in the authoring module's directory, appending nothing", async () => {
    const server = await serve({
      build: node({ module, entry: 'server.js', dev: ['bun', '--watch', 'server.ts'] }),
      address: 'api',
    });

    expect(server?.cwd).toBe(path.dirname(fileURLToPath(module)));
    expect(server?.display).toBe('bun --watch server.ts');
    expect(server?.argv({ port: 3000, host: '0.0.0.0' })).toEqual(['bun', '--watch', 'server.ts']);
  });

  test('the registered descriptor carries serve beside assemble', () => {
    const descriptor = nodeBuild().nodes['node'];
    expect(descriptor?.kind === 'build' ? descriptor.serve : undefined).toBe(serve);
  });
});
