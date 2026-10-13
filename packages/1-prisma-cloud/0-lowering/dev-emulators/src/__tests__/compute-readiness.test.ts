/**
 * A service counts as running only once its port accepts a connection. A
 * deployment PUT and a session-resume start return only then, and fail,
 * naming the service and its log, when the child exits first or never
 * listens. `prisma dev` prints its URLs after these calls return, so a
 * request right after the URLs must connect.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as net from 'node:net';
import { fileURLToPath } from 'node:url';
import { type ComputeClient, computeClient } from '../client.ts';
import { stopDaemon } from '../daemon.ts';
import {
  CRASHING_BOOTSTRAP,
  DELAYED_SERVING_BOOTSTRAP,
  ensureFreshDaemon,
  NEVER_LISTENING_BOOTSTRAP,
  servingBootstrapEnv,
  skipContendedServicePorts,
  tempDir,
  writeBootstrap,
} from './helpers.ts';

const LISTEN_DELAY_MS = 1500;

let registryRoot: string;

afterEach(async () => {
  await stopDaemon('compute', { registryRoot }).catch(() => undefined);
});

function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  const path = process.env['PATH'];
  if (!path) throw new Error('PATH is not set in this shell');
  return { PATH: path, ...extra };
}

function acceptsConnection(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function startDaemon(entry?: string): Promise<ComputeClient> {
  registryRoot = tempDir('compute-readiness-registry');
  await ensureFreshDaemon('compute', registryRoot, entry);
  const client = computeClient({ registryRoot });
  await skipContendedServicePorts(client);
  return client;
}

async function statusOf(client: ComputeClient, app: string, id: string): Promise<string> {
  const svc = (await client.listServices(app)).find((s) => s.id === id);
  if (!svc) throw new Error(`service "${id}" not found in app "${app}"`);
  return svc.status;
}

describe('with the default readiness timeout', () => {
  let client: ComputeClient;

  beforeEach(async () => {
    client = await startDaemon();
  });

  test('a deployment returns only once a slow-booting service accepts connections', async () => {
    const artifactDir = writeBootstrap(DELAYED_SERVING_BOOTSTRAP);
    const reserved = await client.ensureService('app-slow', 'web');

    const deployed = client.putDeployment('app-slow', 'web', {
      address: 'slow.web',
      artifactDir,
      artifactHash: 'h',
      env: baseEnv({
        PORT: String(reserved.port),
        LISTEN_DELAY_MS: String(LISTEN_DELAY_MS),
        ...servingBootstrapEnv('slow but ready'),
      }),
      port: reserved.port,
    });
    await Bun.sleep(LISTEN_DELAY_MS / 2);
    expect(await statusOf(client, 'app-slow', 'web')).not.toBe('running');

    await deployed;

    expect(await acceptsConnection(reserved.port)).toBe(true);
    expect(await statusOf(client, 'app-slow', 'web')).toBe('running');
    const res = await fetch(`http://localhost:${String(reserved.port)}`);
    expect(await res.text()).toBe('slow but ready');
  }, 15_000);

  test('a session-resume start returns only once a slow-booting service accepts connections', async () => {
    const artifactDir = writeBootstrap(DELAYED_SERVING_BOOTSTRAP);
    const reserved = await client.ensureService('app-resume', 'web');
    await client.putDeployment('app-resume', 'web', {
      address: 'resume.web',
      artifactDir,
      artifactHash: 'h',
      env: baseEnv({
        PORT: String(reserved.port),
        LISTEN_DELAY_MS: String(LISTEN_DELAY_MS),
        ...servingBootstrapEnv('resumed'),
      }),
      port: reserved.port,
    });
    await client.stopApp('app-resume');
    expect(await acceptsConnection(reserved.port)).toBe(false);

    await client.startApp('app-resume');

    expect(await acceptsConnection(reserved.port)).toBe(true);
    expect(await statusOf(client, 'app-resume', 'web')).toBe('running');
  }, 20_000);

  test('a service that exits before it listens fails the deployment, naming the service and its log', async () => {
    const artifactDir = writeBootstrap(CRASHING_BOOTSTRAP);
    const reserved = await client.ensureService('app-crash', 'web');

    const deployed = client.putDeployment('app-crash', 'web', {
      address: 'crash.web',
      artifactDir,
      artifactHash: 'h',
      env: baseEnv(),
      port: reserved.port,
    });

    await expect(deployed).rejects.toThrow(
      /service "crash\.web" exited \(code 1\) before it accepted connections on its port \d+\. Its log: .*web\.log/,
    );
  }, 15_000);

  test('a session-resume start of a service that exits before it listens fails, naming the service', async () => {
    const artifactDir = writeBootstrap(CRASHING_BOOTSTRAP);
    const reserved = await client.ensureService('app-crash-resume', 'web');
    await client
      .putDeployment('app-crash-resume', 'web', {
        address: 'crash-resume.web',
        artifactDir,
        artifactHash: 'h',
        env: baseEnv(),
        port: reserved.port,
      })
      .catch(() => undefined);
    await client.stopApp('app-crash-resume');

    await expect(client.startApp('app-crash-resume')).rejects.toThrow(
      /service "crash-resume\.web" exited \(code 1\) before it accepted connections/,
    );
  }, 15_000);
});

describe('with a 1-second readiness timeout', () => {
  test('a service that never listens fails the deployment, is stopped, and its log says why', async () => {
    const client = await startDaemon(
      fileURLToPath(new URL('./fixtures/short-ready-timeout.ts', import.meta.url)),
    );
    const artifactDir = writeBootstrap(NEVER_LISTENING_BOOTSTRAP);
    const reserved = await client.ensureService('app-silent', 'web');

    const deployed = client.putDeployment('app-silent', 'web', {
      address: 'silent.web',
      artifactDir,
      artifactHash: 'h',
      env: baseEnv(),
      port: reserved.port,
    });

    await expect(deployed).rejects.toThrow(
      /service "silent\.web" did not accept connections on its port \d+ within 1s\. Its log: .*web\.log/,
    );
    const [svc] = await client.listServices('app-silent');
    expect(svc?.status).toBe('stopped');
    expect(svc?.pid).toBeUndefined();
    const log = await (await fetch(`${client.baseUrl}/apps/app-silent/services/web/logs`)).text();
    expect(log).toContain('[emulator] did not accept connections on port');
  }, 15_000);
});
