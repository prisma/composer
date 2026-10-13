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
import { type ComputeClient, computeClient, type ServiceInstanceInfo } from '../client.ts';
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

async function instanceOf(client: ComputeClient, id: string): Promise<ServiceInstanceInfo> {
  const instance = await client.getInstance(id);
  if (!instance) throw new Error(`instance "${id}" not found`);
  return instance;
}

async function statusOf(client: ComputeClient, id: string): Promise<string> {
  return (await instanceOf(client, id)).status;
}

describe('with the default readiness timeout', () => {
  let client: ComputeClient;

  beforeEach(async () => {
    client = await startDaemon();
  });

  test('a deployment returns only once a slow-booting service accepts connections', async () => {
    const artifactDir = writeBootstrap(DELAYED_SERVING_BOOTSTRAP);
    const reserved = await client.createInstance({ labels: {} });

    const deployed = client.putDeployment(reserved.id, {
      artifactDir,
      artifactHash: 'h',
      env: baseEnv({
        PORT: String(reserved.port),
        LISTEN_DELAY_MS: String(LISTEN_DELAY_MS),
        ...servingBootstrapEnv('slow but ready'),
      }),
    });
    await Bun.sleep(LISTEN_DELAY_MS / 2);
    expect(await statusOf(client, reserved.id)).not.toBe('running');

    await deployed;

    expect(await acceptsConnection(reserved.port)).toBe(true);
    expect(await statusOf(client, reserved.id)).toBe('running');
    const res = await fetch(`http://localhost:${String(reserved.port)}`);
    expect(await res.text()).toBe('slow but ready');
  }, 15_000);

  test('a session-resume start returns only once a slow-booting service accepts connections', async () => {
    const artifactDir = writeBootstrap(DELAYED_SERVING_BOOTSTRAP);
    const reserved = await client.createInstance({ labels: {} });
    await client.putDeployment(reserved.id, {
      artifactDir,
      artifactHash: 'h',
      env: baseEnv({
        PORT: String(reserved.port),
        LISTEN_DELAY_MS: String(LISTEN_DELAY_MS),
        ...servingBootstrapEnv('resumed'),
      }),
    });
    await client.stopInstances([reserved.id]);
    expect(await acceptsConnection(reserved.port)).toBe(false);

    await client.startInstances([reserved.id]);

    expect(await acceptsConnection(reserved.port)).toBe(true);
    expect(await statusOf(client, reserved.id)).toBe('running');
  }, 20_000);

  test('a service that exits before it listens fails the deployment, naming the service and its log', async () => {
    const artifactDir = writeBootstrap(CRASHING_BOOTSTRAP);
    const reserved = await client.createInstance({ labels: {} });

    const deployed = client.putDeployment(reserved.id, {
      artifactDir,
      artifactHash: 'h',
      env: baseEnv(),
    });

    await expect(deployed).rejects.toThrow(
      new RegExp(
        `instance "${reserved.id}" exited \\(code 1\\) before it accepted connections on its port ${String(reserved.port)}\\. Its log: .*${reserved.id}\\.log`,
      ),
    );
  }, 15_000);

  test('a session-resume start of a service that exits before it listens fails, naming the service', async () => {
    const artifactDir = writeBootstrap(CRASHING_BOOTSTRAP);
    const reserved = await client.createInstance({ labels: {} });
    await client
      .putDeployment(reserved.id, {
        artifactDir,
        artifactHash: 'h',
        env: baseEnv(),
      })
      .catch(() => undefined);
    await client.stopInstances([reserved.id]);

    await expect(client.startInstances([reserved.id])).rejects.toThrow(
      `instance "${reserved.id}" exited (code 1) before it accepted connections`,
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
      artifactDir,
      artifactHash: hash,
      env: baseEnv({
        PORT: String(port),
        LISTEN_DELAY_MS: String(LISTEN_DELAY_MS),
        ...servingBootstrapEnv(body),
      }),
    };
  }

  test('a redeploy of a running service is not running until the new process listens', async () => {
    const artifactDir = writeBootstrap(DELAYED_SERVING_BOOTSTRAP);
    const reserved = await client.createInstance({ labels: {} });
    await client.putDeployment(
      reserved.id,
      delayedDeployment(reserved.port, 'v1', 'first', artifactDir),
    );

    const redeployed = client.putDeployment(
      reserved.id,
      delayedDeployment(reserved.port, 'v2', 'second', artifactDir),
    );
    await Bun.sleep(LISTEN_DELAY_MS / 2);
    expect(await statusOf(client, reserved.id)).not.toBe('running');

    await redeployed;

    expect(await statusOf(client, reserved.id)).toBe('running');
    const res = await fetch(`http://localhost:${String(reserved.port)}`);
    expect(await res.text()).toBe('second');
  }, 20_000);

  test('a repeated identical deployment during a redeploy waits for the new process', async () => {
    const artifactDir = writeBootstrap(DELAYED_SERVING_BOOTSTRAP);
    const reserved = await client.createInstance({ labels: {} });
    await client.putDeployment(
      reserved.id,
      delayedDeployment(reserved.port, 'v1', 'first', artifactDir),
    );

    const redeployed = client.putDeployment(
      reserved.id,
      delayedDeployment(reserved.port, 'v2', 'second', artifactDir),
    );
    await Bun.sleep(300);
    await client.putDeployment(
      reserved.id,
      delayedDeployment(reserved.port, 'v2', 'second', artifactDir),
    );

    expect(await acceptsConnection(reserved.port)).toBe(true);
    const res = await fetch(`http://localhost:${String(reserved.port)}`);
    expect(await res.text()).toBe('second');
    await redeployed;
  }, 20_000);

  test('a session-resume start during a redeploy waits for the new process', async () => {
    const artifactDir = writeBootstrap(DELAYED_SERVING_BOOTSTRAP);
    const reserved = await client.createInstance({ labels: {} });
    await client.putDeployment(
      reserved.id,
      delayedDeployment(reserved.port, 'v1', 'first', artifactDir),
    );

    const redeployed = client.putDeployment(
      reserved.id,
      delayedDeployment(reserved.port, 'v2', 'second', artifactDir),
    );
    await Bun.sleep(300);
    await client.startInstances([reserved.id]);

    const res = await fetch(`http://localhost:${String(reserved.port)}`);
    expect(await res.text()).toBe('second');
    await redeployed;
  }, 20_000);

  test('two concurrent session-resume starts share one process', async () => {
    const artifactDir = writeBootstrap(DELAYED_SERVING_BOOTSTRAP);
    const reserved = await client.createInstance({ labels: {} });
    await client.putDeployment(
      reserved.id,
      delayedDeployment(reserved.port, 'v1', 'once', artifactDir),
    );
    await client.stopInstances([reserved.id]);

    await Promise.all([client.startInstances([reserved.id]), client.startInstances([reserved.id])]);

    const log = await (await fetch(`${client.baseUrl}/instances/${reserved.id}/logs`)).text();
    expect(log.match(/booted pid/g)?.length).toBe(1);
    const svc = await instanceOf(client, reserved.id);
    expect(svc?.status).toBe('running');
    expect(log).toContain(`booted pid ${String(svc?.pid)}`);
  }, 20_000);

  test('a deployment replaced during its start waits for the replacement instead of failing', async () => {
    const artifactDir = writeBootstrap(DELAYED_SERVING_BOOTSTRAP);
    const reserved = await client.createInstance({ labels: {} });

    const first = client.putDeployment(
      reserved.id,
      delayedDeployment(reserved.port, 'v1', 'first', artifactDir),
    );
    await Bun.sleep(300);
    const second = client.putDeployment(
      reserved.id,
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
    const reserved = await client.createInstance({ labels: {} });

    const deployed = client
      .putDeployment(reserved.id, delayedDeployment(reserved.port, 'v1', 'first', artifactDir))
      .catch(() => undefined);
    await Bun.sleep(300);
    const first = await instanceOf(client, reserved.id);
    const firstPid = first?.pid;
    expect(firstPid).toBeDefined();
    const stopped = client.stopInstances([reserved.id]);
    await Bun.sleep(200);

    await client.startInstances([reserved.id]);
    await stopped;
    await deployed;

    const svc = await instanceOf(client, reserved.id);
    expect(svc?.status).toBe('running');
    expect(svc?.pid).not.toBe(firstPid);
    expect(isPidAlive(firstPid ?? 0)).toBe(false);
    const log = await (await fetch(`${client.baseUrl}/instances/${reserved.id}/logs`)).text();
    expect(log).not.toContain('[emulator] exited');
    expect(log.match(/booted pid/g)?.length).toBe(1);

    await stopDaemon('compute', { registryRoot });
    await waitFor(() => !isPidAlive(svc?.pid ?? 0), 10_000, 100);
  }, 30_000);

  const IGNORES_SIGTERM = `process.on('SIGTERM', () => {});\n${DELAYED_SERVING_BOOTSTRAP}`;

  function quickDeployment(port: number, artifactDir: string) {
    return {
      artifactDir,
      artifactHash: 'v1',
      env: baseEnv({ PORT: String(port), LISTEN_DELAY_MS: '300', ...servingBootstrapEnv('x') }),
    };
  }

  test('stop, start, stop: a stop during a waiting start cancels it', async () => {
    const artifactDir = writeBootstrap(IGNORES_SIGTERM);
    const reserved = await client.createInstance({ labels: {} });
    await client.putDeployment(reserved.id, quickDeployment(reserved.port, artifactDir));

    const firstStop = client.stopInstances([reserved.id]);
    await Bun.sleep(200);
    const start = client.startInstances([reserved.id]).catch((e: unknown) => String(e));
    await Bun.sleep(200);
    const secondStop = client.stopInstances([reserved.id]);
    await Promise.all([firstStop, start, secondStop]);

    expect(await statusOf(client, reserved.id)).toBe('stopped');
    expect(await start).toContain('was stopped before it accepted connections');
    expect(await acceptsConnection(reserved.port)).toBe(false);
  }, 30_000);

  test('an identical deployment during a stop waits for the stop and starts the service again', async () => {
    const artifactDir = writeBootstrap(IGNORES_SIGTERM);
    const reserved = await client.createInstance({ labels: {} });
    await client.putDeployment(reserved.id, quickDeployment(reserved.port, artifactDir));

    const stopped = client.stopInstances([reserved.id]);
    await Bun.sleep(200);
    await client.putDeployment(reserved.id, quickDeployment(reserved.port, artifactDir));
    await stopped;

    expect(await statusOf(client, reserved.id)).toBe('running');
    expect(await acceptsConnection(reserved.port)).toBe(true);
    const svc = await instanceOf(client, reserved.id);
    if (svc?.pid !== undefined) process.kill(svc.pid, 'SIGKILL');
  }, 30_000);

  test('a start during an instance delete leaves no process behind', async () => {
    const artifactDir = writeBootstrap(IGNORES_SIGTERM);
    const reserved = await client.createInstance({ labels: {} });
    await client.putDeployment(reserved.id, quickDeployment(reserved.port, artifactDir));

    const deleted = client.deleteInstance(reserved.id);
    await Bun.sleep(200);
    const start = await client.startInstances([reserved.id]).then(
      () => 'ok',
      (e: unknown) => String(e),
    );
    await deleted;
    await Bun.sleep(1000);

    const leaked = acceptsConnection(reserved.port);
    const leakedPids = Bun.spawnSync([
      'lsof',
      '-ti',
      `tcp:${String(reserved.port)}`,
      '-sTCP:LISTEN',
    ])
      .stdout.toString()
      .trim();
    for (const pid of leakedPids.split('\n').filter(Boolean)) process.kill(Number(pid), 'SIGKILL');
    expect(await leaked).toBe(false);
    expect(start).toContain('was stopped before it accepted connections');
    expect(await client.getInstance(reserved.id)).toBeUndefined();
  }, 30_000);

  test('a deployment stopped during its start fails saying it was stopped', async () => {
    const artifactDir = writeBootstrap(DELAYED_SERVING_BOOTSTRAP);
    const reserved = await client.createInstance({ labels: {} });

    const deployed = client.putDeployment(
      reserved.id,
      delayedDeployment(reserved.port, 'v1', 'first', artifactDir),
    );
    await Bun.sleep(300);
    await client.stopInstances([reserved.id]);

    await expect(deployed).rejects.toThrow(
      `instance "${reserved.id}" was stopped before it accepted connections`,
    );
    expect(await statusOf(client, reserved.id)).toBe('stopped');
  }, 20_000);
});

describe('with a 1-second readiness timeout', () => {
  test('a service that never listens fails the deployment, is stopped, and its log says why', async () => {
    const client = await startDaemon(
      fileURLToPath(new URL('./fixtures/short-ready-timeout.ts', import.meta.url)),
    );
    const artifactDir = writeBootstrap(NEVER_LISTENING_BOOTSTRAP);
    const reserved = await client.createInstance({ labels: {} });

    const deployed = client.putDeployment(reserved.id, {
      artifactDir,
      artifactHash: 'h',
      env: baseEnv(),
    });

    await expect(deployed).rejects.toThrow(
      new RegExp(
        `instance "${reserved.id}" did not accept connections on its port ${String(reserved.port)} within 1s\\. Its log: .*${reserved.id}\\.log`,
      ),
    );
    const svc = await instanceOf(client, reserved.id);
    expect(svc?.status).toBe('stopped');
    expect(svc?.pid).toBeUndefined();
    const log = await (await fetch(`${client.baseUrl}/instances/${reserved.id}/logs`)).text();
    expect(log).toContain('[emulator] did not accept connections on port');
  }, 15_000);

  test('a restart after a crash that never listens ends held, and its log says why', async () => {
    const client = await startDaemon(
      fileURLToPath(new URL('./fixtures/short-ready-timeout.ts', import.meta.url)),
    );
    const artifactDir = writeBootstrap(CRASH_ONCE_THEN_SILENT_BOOTSTRAP);
    const reserved = await client.createInstance({ labels: {} });

    await expect(
      client.putDeployment(reserved.id, {
        artifactDir,
        artifactHash: 'h',
        env: baseEnv(),
      }),
    ).rejects.toThrow('exited (code 1)');

    await waitFor(async () => (await statusOf(client, reserved.id)) === 'held', 8000, 100);
    const svc = await instanceOf(client, reserved.id);
    expect(svc?.pid).toBeUndefined();
    const log = await (await fetch(`${client.baseUrl}/instances/${reserved.id}/logs`)).text();
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
    const reserved = await client.createInstance({ labels: {} });

    const deployed = client.putDeployment(reserved.id, {
      artifactDir,
      artifactHash: 'h',
      env: baseEnv(),
    });

    await expect(deployed).rejects.toThrow('within 1s. Its log: ');
    await expect(
      client.putDeployment(reserved.id, {
        artifactDir,
        artifactHash: 'h2',
        env: baseEnv(),
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
