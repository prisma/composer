import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Load, module, secret, string } from '@internal/core';
import { secretsStore } from '@internal/lowering/dev';
import { PrismaCloudContainer } from '../container.ts';
import { runDevPreflight } from '../dev/preflight.ts';
import { compute } from '../exports/index.ts';
import { envParam } from '../param.ts';
import { envSecret } from '../secret.ts';

const build = {
  extension: '@prisma/composer/node',
  type: 'node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};

const fakeContainer = () =>
  new PrismaCloudContainer({ appName: 'app', stage: undefined }, 'local', undefined);

const secretGraph = () =>
  Load(
    module('app', ({ provision }) => {
      provision(compute({ name: 'ingest', deps: {}, secrets: { stripeKey: secret() }, build }), {
        id: 'ingest',
        secrets: { stripeKey: envSecret('STRIPE_SECRET_KEY') },
      });
    }),
  );

const paramGraph = () =>
  Load(
    module('app', ({ provision }) => {
      provision(compute({ name: 'web', deps: {}, params: { appOrigin: string() }, build }), {
        id: 'web',
        params: { appOrigin: envParam('APP_ORIGIN') },
      });
    }),
  );

describe('runDevPreflight (local-dev spec S5, ADR-0041 D7)', () => {
  let cwd: string;
  let previousCwd: string;
  let warnings: string[];
  let originalWarn: typeof console.warn;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-preflight-test-'));
    previousCwd = process.cwd();
    process.chdir(cwd);
    delete process.env['STRIPE_SECRET_KEY'];
    delete process.env['APP_ORIGIN'];
    warnings = [];
    originalWarn = console.warn;
    console.warn = (msg: string) => {
      warnings.push(msg);
    };
  });

  afterEach(() => {
    process.chdir(previousCwd);
    fs.rmSync(cwd, { recursive: true, force: true });
    console.warn = originalWarn;
  });

  test('a missing secret mints a placeholder, persists it, and warns exactly once', async () => {
    await runDevPreflight({ graph: secretGraph(), container: fakeContainer(), stage: undefined });

    const stored = await secretsStore(path.join(cwd, '.prisma-composer', 'dev')).read();
    expect(stored['STRIPE_SECRET_KEY']).toMatch(/^local-placeholder-[0-9a-f]{16}$/);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toBe(
      '[dev] STRIPE_SECRET_KEY is not set in this shell — using a local placeholder. Anything ' +
        'that talks to the real service behind it will fail; everything else runs.',
    );
  });

  test('the minted placeholder is stable across two preflight runs', async () => {
    await runDevPreflight({ graph: secretGraph(), container: fakeContainer(), stage: undefined });
    const first = (await secretsStore(path.join(cwd, '.prisma-composer', 'dev')).read())[
      'STRIPE_SECRET_KEY'
    ];

    await runDevPreflight({ graph: secretGraph(), container: fakeContainer(), stage: undefined });
    const second = (await secretsStore(path.join(cwd, '.prisma-composer', 'dev')).read())[
      'STRIPE_SECRET_KEY'
    ];

    expect(second).toBe(first);
    // The pinned policy warns only on the MINT branch — reusing an already-
    // persisted placeholder is silent, so the second run adds no warning.
    expect(warnings).toHaveLength(1);
  });

  test('a secret set in the shell is used directly, with no placeholder and no warning', async () => {
    process.env['STRIPE_SECRET_KEY'] = 'sk_live_from_shell';

    await runDevPreflight({ graph: secretGraph(), container: fakeContainer(), stage: undefined });

    const stored = await secretsStore(path.join(cwd, '.prisma-composer', 'dev')).read();
    expect(stored['STRIPE_SECRET_KEY']).toBe('sk_live_from_shell');
    expect(warnings).toEqual([]);
  });

  test('a missing env-sourced param is a hard error listing the name and service, instructing the shell fix', async () => {
    const error: unknown = await runDevPreflight({
      graph: paramGraph(),
      container: fakeContainer(),
      stage: undefined,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('APP_ORIGIN');
    expect(message).toContain('service "web"');
    expect(message).toContain('Set each in the shell you run `prisma-composer dev` from.');
  });

  test('an env-sourced param present in the shell is written to secrets.json with no error', async () => {
    process.env['APP_ORIGIN'] = 'https://localhost:3000';

    await runDevPreflight({ graph: paramGraph(), container: fakeContainer(), stage: undefined });

    const stored = await secretsStore(path.join(cwd, '.prisma-composer', 'dev')).read();
    expect(stored['APP_ORIGIN']).toBe('https://localhost:3000');
  });
});
