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
import { ensureDaemon, isPidAlive, SERVICE_READY_TIMEOUT_ENV, stopDaemon } from '../daemon.ts';
import {
  CRASH_ONCE_THEN_SILENT_BOOTSTRAP,
  CRASHING_BOOTSTRAP,
  DELAYED_SERVING_BOOTSTRAP,
  ensureFreshDaemon,
  NEVER_LISTENING_BOOTSTRAP,
  servingBootstrapEnv,
  skipContendedServicePorts,
  tempDir,
  waitFor,
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

describe('a start that is replaced, stopped or joined', () => {
  let client: ComputeClient;

  beforeEach(async () => {
    client = await startDaemon();
  });

  function delayedDeployment(port: number, hash: string, body: string, artifactDir: string) {
    return {
      address: 'slow.web',
      artifactDir,
      artifactHash: hash,
      env: baseEnv({
        PORT: String(port),
        LISTEN_DELAY_MS: String(LISTEN_DELAY_MS),
        ...servingBootstrapEnv(body),
      }),
      port,
    };
  }

  test('a redeploy of a running service is not running until the new process listens', async () => {
    const artifactDir = writeBootstrap(DELAYED_SERVING_BOOTSTRAP);
    const reserved = await client.ensureService('app-redeploy', 'web');
    await client.putDeployment(
      'app-redeploy',
      'web',
      delayedDeployment(reserved.port, 'v1', 'first', artifactDir),
    );

    const redeployed = client.putDeployment(
      'app-redeploy',
      'web',
      delayedDeployment(reserved.port, 'v2', 'second', artifactDir),
    );
    await Bun.sleep(LISTEN_DELAY_MS / 2);
    expect(await statusOf(client, 'app-redeploy', 'web')).not.toBe('running');

    await redeployed;

    expect(await statusOf(client, 'app-redeploy', 'web')).toBe('running');
    const res = await fetch(`http://localhost:${String(reserved.port)}`);
    expect(await res.text()).toBe('second');
  }, 20_000);

  test('a repeated identical deployment during a redeploy waits for the new process', async () => {
    const artifactDir = writeBootstrap(DELAYED_SERVING_BOOTSTRAP);
    const reserved = await client.ensureService('app-repeat', 'web');
    await client.putDeployment(
      'app-repeat',
      'web',
      delayedDeployment(reserved.port, 'v1', 'first', artifactDir),
    );

    const redeployed = client.putDeployment(
      'app-repeat',
      'web',
      delayedDeployment(reserved.port, 'v2', 'second', artifactDir),
    );
    await Bun.sleep(300);
    await client.putDeployment(
      'app-repeat',
      'web',
      delayedDeployment(reserved.port, 'v2', 'second', artifactDir),
    );

    expect(await acceptsConnection(reserved.port)).toBe(true);
    const res = await fetch(`http://localhost:${String(reserved.port)}`);
    expect(await res.text()).toBe('second');
    await redeployed;
  }, 20_000);

  test('a session-resume start during a redeploy waits for the new process', async () => {
    const artifactDir = writeBootstrap(DELAYED_SERVING_BOOTSTRAP);
    const reserved = await client.ensureService('app-resume-redeploy', 'web');
    await client.putDeployment(
      'app-resume-redeploy',
      'web',
      delayedDeployment(reserved.port, 'v1', 'first', artifactDir),
    );

    const redeployed = client.putDeployment(
      'app-resume-redeploy',
      'web',
      delayedDeployment(reserved.port, 'v2', 'second', artifactDir),
    );
    await Bun.sleep(300);
    await client.startApp('app-resume-redeploy');

    const res = await fetch(`http://localhost:${String(reserved.port)}`);
    expect(await res.text()).toBe('second');
    await redeployed;
  }, 20_000);

  test('two concurrent session-resume starts share one process', async () => {
    const artifactDir = writeBootstrap(DELAYED_SERVING_BOOTSTRAP);
    const reserved = await client.ensureService('app-twice', 'web');
    await client.putDeployment(
      'app-twice',
      'web',
      delayedDeployment(reserved.port, 'v1', 'once', artifactDir),
    );
    await client.stopApp('app-twice');

    await Promise.all([client.startApp('app-twice'), client.startApp('app-twice')]);

    const log = await (await fetch(`${client.baseUrl}/apps/app-twice/services/web/logs`)).text();
    expect(log.match(/booted pid/g)?.length).toBe(1);
    const [svc] = await client.listServices('app-twice');
    expect(svc?.status).toBe('running');
    expect(log).toContain(`booted pid ${String(svc?.pid)}`);
  }, 20_000);

  test('a deployment replaced during its start waits for the replacement instead of failing', async () => {
    const artifactDir = writeBootstrap(DELAYED_SERVING_BOOTSTRAP);
    const reserved = await client.ensureService('app-replaced', 'web');

    const first = client.putDeployment(
      'app-replaced',
      'web',
      delayedDeployment(reserved.port, 'v1', 'first', artifactDir),
    );
    await Bun.sleep(300);
    const second = client.putDeployment(
      'app-replaced',
      'web',
      delayedDeployment(reserved.port, 'v2', 'second', artifactDir),
    );

    await Promise.all([first, second]);
    const res = await fetch(`http://localhost:${String(reserved.port)}`);
    expect(await res.text()).toBe('second');
  }, 20_000);

  test('a start during a stop waits for the stop, so one process runs and nothing outlives the emulator', async () => {
    const artifactDir = writeBootstrap(
      `process.on('SIGTERM', () => {});\n${DELAYED_SERVING_BOOTSTRAP}`,
    );
    const reserved = await client.ensureService('app-stop-start', 'web');

    const deployed = client
      .putDeployment(
        'app-stop-start',
        'web',
        delayedDeployment(reserved.port, 'v1', 'first', artifactDir),
      )
      .catch(() => undefined);
    await Bun.sleep(300);
    const [first] = await client.listServices('app-stop-start');
    const firstPid = first?.pid;
    expect(firstPid).toBeDefined();
    const stopped = client.stopApp('app-stop-start');
    await Bun.sleep(200);

    await client.startApp('app-stop-start');
    await stopped;
    await deployed;

    const [svc] = await client.listServices('app-stop-start');
    expect(svc?.status).toBe('running');
    expect(svc?.pid).not.toBe(firstPid);
    expect(isPidAlive(firstPid ?? 0)).toBe(false);
    const log = await (
      await fetch(`${client.baseUrl}/apps/app-stop-start/services/web/logs`)
    ).text();
    expect(log).not.toContain('[emulator] exited');
    expect(log.match(/booted pid/g)?.length).toBe(1);

    await stopDaemon('compute', { registryRoot });
    await waitFor(() => !isPidAlive(svc?.pid ?? 0), 10_000, 100);
  }, 30_000);

  test('a deployment stopped during its start fails saying it was stopped', async () => {
    const artifactDir = writeBootstrap(DELAYED_SERVING_BOOTSTRAP);
    const reserved = await client.ensureService('app-stopped', 'web');

    const deployed = client.putDeployment(
      'app-stopped',
      'web',
      delayedDeployment(reserved.port, 'v1', 'first', artifactDir),
    );
    await Bun.sleep(300);
    await client.stopApp('app-stopped');

    await expect(deployed).rejects.toThrow(
      'service "slow.web" was stopped before it accepted connections',
    );
    expect(await statusOf(client, 'app-stopped', 'web')).toBe('stopped');
  }, 20_000);
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

  test('a restart after a crash that never listens ends held, and its log says why', async () => {
    const client = await startDaemon(
      fileURLToPath(new URL('./fixtures/short-ready-timeout.ts', import.meta.url)),
    );
    const artifactDir = writeBootstrap(CRASH_ONCE_THEN_SILENT_BOOTSTRAP);
    const reserved = await client.ensureService('app-restart-silent', 'web');

    await expect(
      client.putDeployment('app-restart-silent', 'web', {
        address: 'restart-silent.web',
        artifactDir,
        artifactHash: 'h',
        env: baseEnv(),
        port: reserved.port,
      }),
    ).rejects.toThrow('exited (code 1)');

    await waitFor(
      async () => (await statusOf(client, 'app-restart-silent', 'web')) === 'held',
      8000,
      100,
    );
    const [svc] = await client.listServices('app-restart-silent');
    expect(svc?.pid).toBeUndefined();
    const log = await (
      await fetch(`${client.baseUrl}/apps/app-restart-silent/services/web/logs`)
    ).text();
    expect(log).toContain('did not accept connections on port');
    expect(log).toContain('held');
  }, 20_000);
});

describe(`with ${SERVICE_READY_TIMEOUT_ENV}`, () => {
  const saved = process.env[SERVICE_READY_TIMEOUT_ENV];

  afterEach(() => {
    if (saved === undefined) delete process.env[SERVICE_READY_TIMEOUT_ENV];
    else process.env[SERVICE_READY_TIMEOUT_ENV] = saved;
  });

  test('the compute emulator started with it set waits that long, and the error names it', async () => {
    process.env[SERVICE_READY_TIMEOUT_ENV] = '1000';
    const client = await startDaemon();
    const artifactDir = writeBootstrap(NEVER_LISTENING_BOOTSTRAP);
    const reserved = await client.ensureService('app-env-timeout', 'web');

    const deployed = client.putDeployment('app-env-timeout', 'web', {
      address: 'env-timeout.web',
      artifactDir,
      artifactHash: 'h',
      env: baseEnv(),
      port: reserved.port,
    });

    await expect(deployed).rejects.toThrow('within 1s. Its log: ');
    await expect(
      client.putDeployment('app-env-timeout', 'web', {
        address: 'env-timeout.web',
        artifactDir,
        artifactHash: 'h2',
        env: baseEnv(),
        port: reserved.port,
      }),
    ).rejects.toThrow(SERVICE_READY_TIMEOUT_ENV);
  }, 15_000);

  test('a value that is not a positive whole number fails with DEV.SERVICE_READY_TIMEOUT_INVALID', async () => {
    process.env[SERVICE_READY_TIMEOUT_ENV] = '30s';
    registryRoot = tempDir('compute-readiness-invalid');

    await expect(ensureDaemon('compute', 'unused-entry', { registryRoot })).rejects.toMatchObject({
      code: 'DEV.SERVICE_READY_TIMEOUT_INVALID',
    });
  });
});
