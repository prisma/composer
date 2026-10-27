import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { nextjsBuild, serve } from '../exports/control.ts';
import nextjs from '../exports/index.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** A service module at `<root>/apps/web/src/service.ts` whose Next app is `<root>/apps/web`. */
function fixture(withNext: boolean): { appDir: string; module: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nextjs-serve-')));
  roots.push(root);
  const appDir = path.join(root, 'apps', 'web');
  fs.mkdirSync(path.join(appDir, 'src'), { recursive: true });
  if (withNext) {
    const nextDir = path.join(appDir, 'node_modules', 'next');
    fs.mkdirSync(path.join(nextDir, 'dist', 'bin'), { recursive: true });
    fs.writeFileSync(
      path.join(nextDir, 'package.json'),
      JSON.stringify({ name: 'next', version: '16.0.0', bin: { next: './dist/bin/next' } }),
    );
    fs.writeFileSync(path.join(nextDir, 'dist', 'bin', 'next'), '#!/usr/bin/env node\n');
  }
  return { appDir, module: pathToFileURL(path.join(appDir, 'src', 'service.ts')).href };
}

describe('serve() — the Next.js dev server (ADR-0056)', () => {
  test("runs the app's own `next dev` in appDir, with the port and host as flags", async () => {
    const { appDir, module } = fixture(true);

    const server = await serve({ build: nextjs({ module, appDir: '..' }), address: 'web' });

    expect(server.cwd).toBe(appDir);
    expect(server.display).toBe('next dev');
    expect(server.argv({ port: 3001, host: '0.0.0.0' })).toEqual([
      path.join(appDir, 'node_modules', 'next', 'dist', 'bin', 'next'),
      'dev',
      '-p',
      '3001',
      '-H',
      '0.0.0.0',
    ]);
  });

  test('resolves `next` from appDir the way Node resolves the app — a hoisted install above it counts', async () => {
    const { appDir, module } = fixture(false);
    const hoisted = path.join(appDir, '..', '..', 'node_modules', 'next');
    fs.mkdirSync(hoisted, { recursive: true });
    fs.writeFileSync(
      path.join(hoisted, 'package.json'),
      JSON.stringify({ name: 'next', bin: { next: './dist/bin/next' } }),
    );

    const server = await serve({ build: nextjs({ module, appDir: '..' }), address: 'web' });

    expect(server.argv({ port: 1, host: 'h' })[0]).toBe(path.join(hoisted, 'dist', 'bin', 'next'));
  });

  test('an app without `next` installed fails with the pinned message naming appDir', async () => {
    const { appDir, module } = fixture(false);

    await expect(
      serve({ build: nextjs({ module, appDir: '..' }), address: 'web' }),
    ).rejects.toThrow(
      `cannot find the \`next\` package from ${appDir} — install it there to run this service's dev server`,
    );
  });

  test('the registered descriptor carries serve beside assemble', () => {
    const descriptor = nextjsBuild().nodes['nextjs'];
    expect(descriptor?.kind === 'build' ? descriptor.serve : undefined).toBe(serve);
  });
});
