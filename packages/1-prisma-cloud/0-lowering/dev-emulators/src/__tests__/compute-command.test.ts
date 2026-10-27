/**
 * Command deployments (ADR-0056): a deployment may be a command — a dev
 * server — in place of an artifact. It runs on the instance's port under the
 * same readiness check, log, supervision and restart rules; the emulator
 * learns only that a deployment can be a command.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ComputeClient, computeClient, type ServiceInstanceInfo } from '../client.ts';
import { stopDaemon } from '../daemon.ts';
import {
  ensureFreshDaemon,
  NEVER_LISTENING_BOOTSTRAP,
  SERVING_BOOTSTRAP,
  servingBootstrapEnv,
  skipContendedServicePorts,
  tempDir,
  waitFor,
  waitForHttp,
  writeBootstrap,
} from './helpers.ts';

let registryRoot: string;

afterEach(async () => {
  await stopDaemon('compute', { registryRoot }).catch(() => undefined);
});

async function startDaemon(entry?: string): Promise<ComputeClient> {
  registryRoot = tempDir('compute-command-registry');
  const { url } = await ensureFreshDaemon('compute', registryRoot, entry);
  const client = computeClient({ registryRoot });
  await skipContendedServicePorts(client);
  return Object.assign(client, { url });
}

function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  const pathVar = process.env['PATH'];
  if (!pathVar) throw new Error('PATH is not set in this shell');
  return { PATH: pathVar, ...extra };
}

/** A directory holding `server.js` — the serving fixture, run as a command rather than as an artifact's bootstrap. */
function commandDir(source: string = SERVING_BOOTSTRAP): string {
  const dir = tempDir('command');
  fs.writeFileSync(path.join(dir, 'server.js'), source);
  return dir;
}

async function instance(client: ComputeClient, id: string): Promise<ServiceInstanceInfo> {
  const found = await client.getInstance(id);
  if (!found) throw new Error(`instance "${id}" not found`);
  return found;
}

describe('command deployments', () => {
  test('a command with a bare argv[0] is resolved on the deployment PATH, runs in its cwd, and serves', async () => {
    const client = await startDaemon();
    const cwd = commandDir();
    const reserved = await client.createInstance({ labels: {} });

    const outcome = await client.putDeployment(reserved.id, {
      command: { cwd, argv: ['bun', 'server.js'] },
      env: baseEnv({ PORT: String(reserved.port), ...servingBootstrapEnv('dev server') }),
    });

    expect(outcome).toEqual({ started: true });
    const res = await waitForHttp(`http://127.0.0.1:${String(reserved.port)}`, 3000);
    expect(await res.text()).toBe('dev server');
    const view = await instance(client, reserved.id);
    expect(view.status).toBe('running');
    expect(view.command).toEqual({ cwd, argv: ['bun', 'server.js'] });
    expect(view.artifactHash).toBeUndefined();
  });

  test('an identical command put is a no-op: started is false and the pid is unchanged', async () => {
    const client = await startDaemon();
    const cwd = commandDir();
    const reserved = await client.createInstance({ labels: {} });
    const deployment = {
      command: { cwd, argv: ['bun', 'server.js'] },
      env: baseEnv({ PORT: String(reserved.port), ...servingBootstrapEnv('v1') }),
    };
    await client.putDeployment(reserved.id, deployment);
    const before = await instance(client, reserved.id);

    const outcome = await client.putDeployment(reserved.id, deployment);

    expect(outcome).toEqual({ started: false });
    expect((await instance(client, reserved.id)).pid).toBe(before.pid);
  });

  test('a changed argv, cwd or env restarts the command', async () => {
    const client = await startDaemon();
    const cwd = commandDir();
    const reserved = await client.createInstance({ labels: {} });
    const env = baseEnv({ PORT: String(reserved.port), ...servingBootstrapEnv('v1') });
    await client.putDeployment(reserved.id, { command: { cwd, argv: ['bun', 'server.js'] }, env });
    const first = (await instance(client, reserved.id)).pid;

    const argvChanged = await client.putDeployment(reserved.id, {
      command: { cwd, argv: ['bun', '--smol', 'server.js'] },
      env,
    });
    const second = (await instance(client, reserved.id)).pid;
    const envChanged = await client.putDeployment(reserved.id, {
      command: { cwd, argv: ['bun', '--smol', 'server.js'] },
      env: { ...env, ...servingBootstrapEnv('v2') },
    });

    expect(argvChanged).toEqual({ started: true });
    expect(envChanged).toEqual({ started: true });
    expect(second).not.toBe(first);
    expect((await instance(client, reserved.id)).pid).not.toBe(second);
    const res = await waitForHttp(`http://127.0.0.1:${String(reserved.port)}`, 3000);
    expect(await res.text()).toBe('v2');
  });

  test('switching between an artifact and a command replaces the process and clears the other form', async () => {
    const client = await startDaemon();
    const reserved = await client.createInstance({ labels: {} });
    const env = baseEnv({ PORT: String(reserved.port), ...servingBootstrapEnv('artifact') });
    const artifact = { artifactDir: writeBootstrap(SERVING_BOOTSTRAP), artifactHash: 'h1', env };
    await client.putDeployment(reserved.id, artifact);

    const toCommand = await client.putDeployment(reserved.id, {
      command: { cwd: commandDir(), argv: ['bun', 'server.js'] },
      env,
    });
    const asCommand = await instance(client, reserved.id);
    const toArtifact = await client.putDeployment(reserved.id, artifact);
    const asArtifact = await instance(client, reserved.id);

    expect(toCommand).toEqual({ started: true });
    expect(asCommand.artifactHash).toBeUndefined();
    expect(asCommand.command?.argv).toEqual(['bun', 'server.js']);
    expect(toArtifact).toEqual({ started: true });
    expect(asArtifact.artifactHash).toBe('h1');
    expect(asArtifact.command).toBeUndefined();
  });

  test('a command whose executable is not on the PATH fails the start and leaves the instance stopped', async () => {
    const client = await startDaemon();
    const reserved = await client.createInstance({ labels: {} });

    const failure = await client
      .putDeployment(reserved.id, {
        command: { cwd: commandDir(), argv: ['no-such-dev-server-binary', 'dev'] },
        env: baseEnv({ PORT: String(reserved.port) }),
      })
      .catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain(
      `command "no-such-dev-server-binary" was not found on the deployment's PATH`,
    );
    expect((await instance(client, reserved.id)).status).toBe('stopped');
  });

  test('a body with both an artifact and a command is malformed', async () => {
    const client = await startDaemon();
    const reserved = await client.createInstance({ labels: {} });

    const res = await fetch(`${client.baseUrl}/instances/${reserved.id}/deployment`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        artifactDir: '/x',
        artifactHash: 'h',
        command: { cwd: '/x', argv: ['bun'] },
        env: {},
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toBe('malformed deployment body');
  });

  test('a stopped command instance resumes on start, like an artifact', async () => {
    const client = await startDaemon();
    const reserved = await client.createInstance({ labels: {} });
    await client.putDeployment(reserved.id, {
      command: { cwd: commandDir(), argv: ['bun', 'server.js'] },
      env: baseEnv({ PORT: String(reserved.port), ...servingBootstrapEnv('resumed') }),
    });
    await client.stopInstances([reserved.id]);
    await waitFor(async () => (await instance(client, reserved.id)).status === 'stopped', 7000);

    await client.startInstances([reserved.id]);

    const res = await waitForHttp(`http://127.0.0.1:${String(reserved.port)}`, 3000);
    expect(await res.text()).toBe('resumed');
  });

  test('a command that never listens fails readiness with the dev-server PORT hint', async () => {
    const client = await startDaemon(
      fileURLToPath(new URL('./fixtures/short-ready-timeout.ts', import.meta.url)),
    );
    const reserved = await client.createInstance({ labels: {} });

    const failure = await client
      .putDeployment(reserved.id, {
        command: { cwd: commandDir(NEVER_LISTENING_BOOTSTRAP), argv: ['bun', 'server.js'] },
        env: baseEnv({ PORT: String(reserved.port) }),
      })
      .catch((e: unknown) => e);

    expect(String(failure)).toContain('A dev server must listen on the port in its PORT variable.');
  });
});
