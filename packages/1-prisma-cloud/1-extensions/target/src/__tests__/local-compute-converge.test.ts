/**
 * `prisma dev`'s converge of compute services, under the real Alchemy engine,
 * the real local providers and a real Compute emulator in a temporary
 * emulators directory: a service that runs its artifact takes its keys from
 * its deployment's `variables`, and a dev server from the rows `reserve`
 * writes to `env.json`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dependency, string } from '@internal/core';
import type { LowerContext } from '@internal/core/deploy';
import { EMULATORS_DIR_ENV, ensureDaemon, stopDaemon } from '@internal/dev-emulators';
import { deleteAppInstances, devServerRows, localTargetProviders } from '@internal/local-target';
import { runScratch, scratchStack } from '@internal/lowering/scratch-stack';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import { compute } from '../compute.ts';
import { computeDescriptor } from '../descriptors/compute.ts';
import { GeneratedParamProvider } from '../generated-param-resource.ts';
import { localTargetDescriptor } from '../local-target/descriptor.ts';
import { SentKeysProvider } from '../sent-keys-resource.ts';

const APP = 'devapp';
const savedEmulatorsDir = process.env[EMULATORS_DIR_ENV];

/** Answers with its own address, its process id and every `COMPOSER_` key it was given. */
const echoBootstrap = (address: string) => {
  const portKey = `COMPOSER_${address.toUpperCase().replaceAll('.', '_')}_PORT`;
  return (
    `Bun.serve({ port: JSON.parse(process.env['${portKey}']), fetch: () => Response.json({ ` +
    `address: '${address}', pid: process.pid, keys: Object.fromEntries(Object.entries(process.env)` +
    `.filter(([key]) => key.startsWith('COMPOSER_'))) }) });\n`
  );
};

const build = {
  extension: '@prisma/composer/node',
  type: 'node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};
const nodeOf = () =>
  compute({
    name: 'service',
    deps: {
      upstream: dependency({
        type: 'rpc',
        connection: { params: { url: string({ optional: true }) }, hydrate: (v) => v },
      }),
    },
    build,
  });

interface Service {
  readonly address: string;
  /** The service runs a dev server, so `reserve` stands in for `deploy`. */
  readonly devServer?: boolean;
  readonly upstream?: string;
}

describe.skipIf(process.platform === 'win32')(
  'converging compute services under prisma dev',
  () => {
    let root: string;
    let devDir: string;
    let artifacts: Map<string, { path: string; sha256: string }>;
    let stack: ReturnType<typeof scratchStack>;

    beforeEach(async () => {
      root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'local-converge-')));
      process.env[EMULATORS_DIR_ENV] = path.join(root, 'emulators');
      const entry = fileURLToPath(import.meta.resolve('@internal/dev-emulators/compute-main'));
      await ensureDaemon('compute', entry, { registryRoot: path.join(root, 'emulators') });
      devDir = path.join(root, 'app', '.prisma-composer', 'dev', 'dev');
      fs.mkdirSync(devDir, { recursive: true });
      artifacts = new Map();
      for (const address of ['devapp.a', 'devapp.b']) {
        const dir = path.join(root, 'artifacts', address);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'compute.manifest.json'),
          JSON.stringify({ manifestVersion: '1', entrypoint: 'bootstrap.js', address }),
        );
        fs.writeFileSync(path.join(dir, 'compute.bootstrap.json'), '{}');
        fs.writeFileSync(path.join(dir, 'bootstrap.js'), echoBootstrap(address));
        const tarball = path.join(root, 'artifacts', `${address}.tar.gz`);
        expect(spawnSync('tar', ['-czf', tarball, '-C', dir, ...fs.readdirSync(dir)]).status).toBe(
          0,
        );
        artifacts.set(address, { path: tarball, sha256: address });
      }
      const descriptor = localTargetDescriptor();
      const container = await descriptor.container.ensure({ appName: APP, environment: 'dev' });
      const providers = Layer.mergeAll(
        localTargetProviders({ container, devDir, plainVariableText: {}, namedSecrets: {} }),
        SentKeysProvider(),
        GeneratedParamProvider(),
      );
      stack = scratchStack({ providers, dev: false }, 'local-converge');
    }, 60_000);

    afterEach(async () => {
      await deleteAppInstances({ devDir, app: APP, environment: 'dev' }).catch(() => undefined);
      await stopDaemon('compute', { registryRoot: path.join(root, 'emulators') }).catch(
        () => undefined,
      );
      fs.rmSync(root, { recursive: true, force: true });
      if (savedEmulatorsDir === undefined) delete process.env[EMULATORS_DIR_ENV];
      else process.env[EMULATORS_DIR_ENV] = savedEmulatorsDir;
    });

    const converge = (services: readonly Service[]) =>
      runScratch(
        stack.deploy(
          Effect.gen(function* () {
            const descriptor = computeDescriptor(() => ({
              workspaceId: 'local',
              providerParams: new Map(),
            }));
            for (const service of services) {
              const node = nodeOf();
              const ctx = {
                id: service.address,
                address: service.address,
                node,
                graph: {
                  root: { id: APP },
                  nodes: [{ id: service.address, node }],
                  inputBindings: [],
                  edges: [],
                },
                application: {
                  projectId: 'local',
                  branchId: undefined,
                  defaultBranchId: undefined,
                  branchless: true,
                },
                lowered: new Map(),
                provisioned: new Map(),
              } as unknown as LowerContext;
              const provisioned = yield* descriptor.provision(ctx);
              const serialized = yield* descriptor.serialize(ctx, provisioned, {
                service: { port: 3000 },
                inputs: { upstream: { url: service.upstream } },
              });
              const artifact = artifacts.get(service.address);
              if (artifact === undefined) throw new Error(`no artifact for ${service.address}`);
              if (service.devServer === true) {
                yield* descriptor.reserve?.(ctx, provisioned, serialized) ?? Effect.void;
              } else {
                yield* descriptor.deploy(ctx, provisioned, artifact, serialized);
              }
            }
          }) as Effect.Effect<void>,
        ),
      );

    interface Echo {
      readonly pid: number;
      readonly keys: Record<string, string>;
    }

    const portOf = (address: string): number => {
      const records = JSON.parse(
        fs.readFileSync(path.join(devDir, 'emulator-instances.json'), 'utf8'),
      );
      const port = records?.apps?.[APP]?.nodes?.[address]?.port;
      if (typeof port !== 'number') throw new Error(`no instance recorded for ${address}`);
      return port;
    };

    const echo = async (address: string): Promise<Echo> => {
      const deadline = Date.now() + 15_000;
      while (true) {
        try {
          const response = await fetch(`http://127.0.0.1:${String(portOf(address))}`);
          const body = (await response.json()) as Echo & { address: string };
          if (body.address === address) return body;
        } catch {}
        if (Date.now() > deadline) throw new Error(`${address} never answered`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };

    const envJson = (): Record<string, string> => {
      const file = path.join(devDir, 'env.json');
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    };

    test("a service that runs its artifact boots with its deployment's keys, a null left out, and nothing in env.json", async () => {
      await converge([
        { address: 'devapp.a', upstream: 'http://up.local' },
        { address: 'devapp.b' },
      ]);

      const a = await echo('devapp.a');
      const b = await echo('devapp.b');
      expect(a.keys['COMPOSER_DEVAPP_A_UPSTREAM_URL']).toBe('http://up.local');
      expect(a.keys['COMPOSER_DEVAPP_A_PORT']).toBe(String(portOf('devapp.a')));
      expect('COMPOSER_DEVAPP_B_UPSTREAM_URL' in b.keys).toBe(false);
      expect('COMPOSER_DEVAPP_A_STREAMS_API_KEY' in a.keys).toBe(false);
      expect(Object.keys(a.keys).every((key) => key.startsWith('COMPOSER_DEVAPP_A_'))).toBe(true);
      expect(envJson()).toEqual({});
    }, 60_000);

    test('a changed value, an added key and a key turned to null each restart only the service that reads it; an unchanged converge restarts nothing', async () => {
      await converge([
        { address: 'devapp.a', upstream: 'http://one.local' },
        { address: 'devapp.b' },
      ]);
      const first = { a: await echo('devapp.a'), b: await echo('devapp.b') };

      await converge([
        { address: 'devapp.a', upstream: 'http://one.local' },
        { address: 'devapp.b' },
      ]);
      const unchanged = { a: await echo('devapp.a'), b: await echo('devapp.b') };
      expect(unchanged.a.pid).toBe(first.a.pid);
      expect(unchanged.b.pid).toBe(first.b.pid);

      await converge([
        { address: 'devapp.a', upstream: 'http://two.local' },
        { address: 'devapp.b' },
      ]);
      const changed = { a: await echo('devapp.a'), b: await echo('devapp.b') };
      expect(changed.a.pid).not.toBe(first.a.pid);
      expect(changed.a.keys['COMPOSER_DEVAPP_A_UPSTREAM_URL']).toBe('http://two.local');
      expect(changed.b.pid).toBe(first.b.pid);

      await converge([
        { address: 'devapp.a', upstream: 'http://two.local' },
        { address: 'devapp.b', upstream: 'http://added.local' },
      ]);
      const added = { a: await echo('devapp.a'), b: await echo('devapp.b') };
      expect(added.a.pid).toBe(changed.a.pid);
      expect(added.b.pid).not.toBe(changed.b.pid);
      expect(added.b.keys['COMPOSER_DEVAPP_B_UPSTREAM_URL']).toBe('http://added.local');

      await converge([
        { address: 'devapp.a' },
        { address: 'devapp.b', upstream: 'http://added.local' },
      ]);
      const nulled = { a: await echo('devapp.a'), b: await echo('devapp.b') };
      expect(nulled.a.pid).not.toBe(added.a.pid);
      expect('COMPOSER_DEVAPP_A_UPSTREAM_URL' in nulled.a.keys).toBe(false);
      expect(nulled.b.pid).toBe(added.b.pid);
    }, 120_000);

    test('a dev server gets its rows in env.json, and none for a key sent as null', async () => {
      await converge([{ address: 'devapp.a', devServer: true }]);

      const rows = envJson();
      expect(Object.values(rows).every((value) => typeof value === 'string')).toBe(true);
      expect(Object.keys(rows).sort()).toEqual(['COMPOSER_DEVAPP_A_PORT']);
      expect(await devServerRows(devDir, 'devapp.a')).toEqual(rows);
    }, 60_000);

    test('a service that switches from its artifact to a dev server reads only the rows reserve wrote', async () => {
      await converge([{ address: 'devapp.a', upstream: 'http://artifact.local' }]);
      expect(envJson()).toEqual({});

      await converge([{ address: 'devapp.a', devServer: true }]);

      const rows = await devServerRows(devDir, 'devapp.a');
      expect(Object.keys(rows).sort()).toEqual(['COMPOSER_DEVAPP_A_PORT']);
      expect(envJson()).toEqual(rows);
    }, 60_000);

    test("a service that switches from a dev server to its artifact boots without the dev server's rows, which leave env.json", async () => {
      await converge([{ address: 'devapp.a', devServer: true, upstream: 'http://dev.local' }]);
      expect(envJson()).toHaveProperty('COMPOSER_DEVAPP_A_UPSTREAM_URL', 'http://dev.local');

      await converge([{ address: 'devapp.a' }]);

      const a = await echo('devapp.a');
      expect('COMPOSER_DEVAPP_A_UPSTREAM_URL' in a.keys).toBe(false);
      expect(envJson()).toEqual({});
    }, 60_000);
  },
);
