/**
 * The attachment's `serve` (ADR-0056): a dev server runs on the service's
 * instance as a command deployment, with the deployment's environment
 * stashed address-free as `run()` would, laid over the shell's — against a
 * real Compute emulator in a temporary emulators directory.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DevServer } from '@internal/core/deploy';
import { EMULATORS_DIR_ENV, ensureDaemon, stopDaemon } from '@internal/dev-emulators';
import { deleteAppInstances, ensureServiceInstance } from '@internal/local-target';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { compute } from '../compute.ts';
import { localTargetDescriptor } from '../local-target/descriptor.ts';

const APP = 'serve-app';
const savedEmulatorsDir = process.env[EMULATORS_DIR_ENV];
const SHELL_MARKER = 'PRISMA_COMPOSER_SERVE_TEST_SHELL';

/** Answers with the environment variables the test inspects, so the test reads what the dev server was given. */
const ENV_ECHO_SERVER =
  "const keys = ['PORT', 'HOST', 'COMPOSER_PORT', 'COMPOSER_INPUT', 'STRIPE_KEY', 'COMPOSER_OTHER_ROW', '" +
  SHELL_MARKER +
  "'];\n" +
  "console.log('dev server up');\n" +
  "Bun.serve({ port: Number(process.env['PORT']), fetch: () => Response.json(Object.fromEntries(keys.map((k) => [k, process.env[k] ?? null]))) });\n";

const anyInput: StandardSchemaV1<unknown, unknown> = {
  '~standard': { version: 1, vendor: 'test', validate: (value) => ({ value }) },
};

const gateway = compute({
  name: 'gateway',
  deps: {},
  input: anyInput,
  build: {
    extension: '@prisma/composer/node',
    type: 'node',
    module: 'file:///app/gateway/service.ts',
    entry: 'server.js',
  },
});

describe.skipIf(process.platform === 'win32')('serving a dev server on an instance', () => {
  let root: string;
  let devDir: string;
  let serverDir: string;

  beforeEach(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'target-serve-')));
    process.env[EMULATORS_DIR_ENV] = path.join(root, 'emulators');
    const entry = fileURLToPath(import.meta.resolve('@internal/dev-emulators/compute-main'));
    await ensureDaemon('compute', entry, { registryRoot: path.join(root, 'emulators') });
    devDir = path.join(root, 'app', '.prisma-composer', 'dev', 'dev');
    fs.mkdirSync(devDir, { recursive: true });
    fs.writeFileSync(
      path.join(devDir, 'env.json'),
      JSON.stringify({
        COMPOSER_GATEWAY_INPUT: '{"apiKey":{"$secret":"STRIPE_KEY"}}',
        COMPOSER_OTHER_ROW: 'a sibling service row',
      }),
    );
    fs.writeFileSync(path.join(devDir, 'secrets.json'), JSON.stringify({ STRIPE_KEY: 'sk_real' }));
    serverDir = path.join(root, 'app', 'gateway');
    fs.mkdirSync(serverDir, { recursive: true });
    fs.writeFileSync(path.join(serverDir, 'server.js'), ENV_ECHO_SERVER);
    process.env[SHELL_MARKER] = 'from the shell';
  }, 60_000);

  afterEach(async () => {
    delete process.env[SHELL_MARKER];
    await deleteAppInstances({ devDir, app: APP, environment: 'dev' }).catch(() => undefined);
    await stopDaemon('compute', { registryRoot: path.join(root, 'emulators') }).catch(
      () => undefined,
    );
    fs.rmSync(root, { recursive: true, force: true });
    if (savedEmulatorsDir === undefined) delete process.env[EMULATORS_DIR_ENV];
    else process.env[EMULATORS_DIR_ENV] = savedEmulatorsDir;
  });

  async function attach() {
    const descriptor = localTargetDescriptor();
    const container = await descriptor.container.ensure({ appName: APP, environment: 'dev' });
    return descriptor.attach({ container, devDir });
  }

  const server = (argv: readonly string[]): DevServer => ({
    cwd: serverDir,
    argv: () => argv,
    display: argv.join(' '),
  });

  test("the dev server gets the deployment's rows stashed address-free, PORT and HOST, over the shell's environment", async () => {
    const attachment = await attach();
    const { instance } = await ensureServiceInstance(
      { devDir, app: APP, environment: 'dev' },
      'gateway',
    );

    const { restarted } = (await attachment.serve?.({
      address: 'gateway',
      node: gateway,
      server: server(['bun', 'server.js']),
    })) ?? { restarted: undefined };

    expect(restarted).toBe(true);
    const env = await (await fetch(`http://127.0.0.1:${String(instance.port)}`)).json();
    expect(env).toEqual({
      PORT: String(instance.port),
      HOST: '0.0.0.0',
      COMPOSER_PORT: String(instance.port),
      COMPOSER_INPUT: '{"apiKey":{"$secret":"STRIPE_KEY"}}',
      STRIPE_KEY: 'sk_real',
      // A sibling's row is not this service's to see (scopedEnvRows).
      COMPOSER_OTHER_ROW: null,
      [SHELL_MARKER]: 'from the shell',
    });
  });

  test('serving the same command again restarts nothing; a changed command restarts it', async () => {
    const attachment = await attach();
    const first = await attachment.serve?.({
      address: 'gateway',
      node: gateway,
      server: server(['bun', 'server.js']),
    });
    const same = await attachment.serve?.({
      address: 'gateway',
      node: gateway,
      server: server(['bun', 'server.js']),
    });
    const changed = await attachment.serve?.({
      address: 'gateway',
      node: gateway,
      server: server(['bun', '--smol', 'server.js']),
    });

    expect([first?.restarted, same?.restarted, changed?.restarted]).toEqual([true, false, true]);
  });

  test('logs({ addresses }) follows the dev server', async () => {
    const attachment = await attach();
    await attachment.serve?.({
      address: 'gateway',
      node: gateway,
      server: server(['bun', 'server.js']),
    });
    const controller = new AbortController();

    let seen: { service: string; line: string } | undefined;
    for await (const line of attachment.logs(controller.signal, {
      tail: 10,
      addresses: ['gateway'],
    })) {
      seen = line;
      controller.abort();
    }

    expect(seen).toEqual({ service: 'gateway', line: 'dev server up' });
  });

  test('a dev server that fails to start names the service, not the instance', async () => {
    const attachment = await attach();

    const failure = await attachment
      .serve?.({ address: 'gateway', node: gateway, server: server(['no-such-dev-binary']) })
      .catch((e: unknown) => e);

    expect(String(failure)).toContain('was not found on the deployment');
    expect(String(failure)).not.toContain('svc_');
  });
});
