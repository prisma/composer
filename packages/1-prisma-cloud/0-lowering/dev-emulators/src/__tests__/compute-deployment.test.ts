/**
 * The Compute emulator's deployment lifecycle (local-dev spec § 2
 * `compute-main.ts`): spawn from a real fixture artifact under `bun`,
 * restart-on-change rules, crash backoff/held supervision, and log
 * streaming. Every test uses a temp `registryRoot` and stops the daemon it
 * started.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { computeClient, type ServiceInfo } from '../client.ts';
import { isPidAlive, stopDaemon } from '../daemon.ts';
import {
  CRASHING_BOOTSTRAP,
  ensureFreshDaemon,
  LOGGING_BOOTSTRAP,
  SERVING_BOOTSTRAP,
  servingBootstrapEnv,
  skipContendedServicePorts,
  sleep,
  tempDir,
  waitFor,
  waitForHttp,
  writeBootstrap,
} from './helpers.ts';

let registryRoot: string;
let daemonUrl: string;

beforeEach(async () => {
  registryRoot = tempDir('compute-deploy-registry');
  const { url } = await ensureFreshDaemon('compute', registryRoot);
  daemonUrl = url;
  // The fixtures below actually bind their reserved port (Bun.serve) —
  // steer past any low service port a process outside this test's control
  // already holds, the same class of shared-machine contention the
  // daemon-port retry feature addresses one layer down.
  await skipContendedServicePorts(computeClient({ registryRoot }));
});

afterEach(async () => {
  await stopDaemon('compute', { registryRoot }).catch(() => undefined);
});

function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  const path = process.env['PATH'];
  if (!path) throw new Error('PATH is not set in this shell');
  return { PATH: path, ...extra };
}

async function deployedService(app: string, id: string): Promise<ServiceInfo> {
  const client = computeClient({ registryRoot });
  const list = await client.listServices(app);
  const svc = list.find((s) => s.id === id);
  if (!svc) throw new Error(`service "${id}" not found in app "${app}"`);
  return svc;
}

describe('deployment lifecycle', () => {
  test('a deployment spawns bun bootstrap.js and the service actually serves HTTP', async () => {
    const client = computeClient({ registryRoot });
    const artifactDir = writeBootstrap(SERVING_BOOTSTRAP);
    const reserved = await client.ensureService('app-a', 'web');

    await client.putDeployment('app-a', 'web', {
      address: 'app-a.web',
      artifactDir,
      artifactHash: 'hash-v1',
      env: baseEnv({ PORT: String(reserved.port), ...servingBootstrapEnv('hello from v1') }),
      port: reserved.port,
    });

    await waitFor(async () => {
      const svc = await deployedService('app-a', 'web');
      return svc.status === 'running';
    }, 5000);

    const res = await waitForHttp(`http://127.0.0.1:${String(reserved.port)}`, 3000);
    expect(await res.text()).toBe('hello from v1');
  });

  test('an identical redeploy (same hash and env) does not restart the running child', async () => {
    const client = computeClient({ registryRoot });
    const artifactDir = writeBootstrap(SERVING_BOOTSTRAP);
    const reserved = await client.ensureService('app-b', 'web');
    const env = baseEnv({ PORT: String(reserved.port), ...servingBootstrapEnv('v1') });

    await client.putDeployment('app-b', 'web', {
      address: 'app-b.web',
      artifactDir,
      artifactHash: 'same-hash',
      env,
      port: reserved.port,
    });
    await waitFor(async () => (await deployedService('app-b', 'web')).status === 'running', 5000);
    const before = await deployedService('app-b', 'web');

    await client.putDeployment('app-b', 'web', {
      address: 'app-b.web',
      artifactDir,
      artifactHash: 'same-hash',
      env,
      port: reserved.port,
    });
    const after = await deployedService('app-b', 'web');
    expect(after.pid).toBe(before.pid);
  });

  test('a redeploy with a changed artifactHash restarts the child (new pid)', async () => {
    const client = computeClient({ registryRoot });
    const artifactDir = writeBootstrap(SERVING_BOOTSTRAP);
    const reserved = await client.ensureService('app-c', 'web');
    const env = baseEnv({ PORT: String(reserved.port), ...servingBootstrapEnv('v1') });

    await client.putDeployment('app-c', 'web', {
      address: 'app-c.web',
      artifactDir,
      artifactHash: 'hash-1',
      env,
      port: reserved.port,
    });
    await waitFor(async () => (await deployedService('app-c', 'web')).status === 'running', 5000);
    const before = await deployedService('app-c', 'web');

    await client.putDeployment('app-c', 'web', {
      address: 'app-c.web',
      artifactDir,
      artifactHash: 'hash-2',
      env,
      port: reserved.port,
    });
    await waitFor(async () => {
      const svc = await deployedService('app-c', 'web');
      return svc.status === 'running' && svc.pid !== before.pid;
    }, 5000);
  });

  test('a redeploy with a changed env (same hash) also restarts the child', async () => {
    const client = computeClient({ registryRoot });
    const artifactDir = writeBootstrap(SERVING_BOOTSTRAP);
    const reserved = await client.ensureService('app-d', 'web');

    await client.putDeployment('app-d', 'web', {
      address: 'app-d.web',
      artifactDir,
      artifactHash: 'stable-hash',
      env: baseEnv({ PORT: String(reserved.port), EXTRA: 'a', ...servingBootstrapEnv('v1') }),
      port: reserved.port,
    });
    await waitFor(async () => (await deployedService('app-d', 'web')).status === 'running', 5000);
    const before = await deployedService('app-d', 'web');

    await client.putDeployment('app-d', 'web', {
      address: 'app-d.web',
      artifactDir,
      artifactHash: 'stable-hash',
      env: baseEnv({ PORT: String(reserved.port), EXTRA: 'b', ...servingBootstrapEnv('v1') }),
      port: reserved.port,
    });
    await waitFor(async () => {
      const svc = await deployedService('app-d', 'web');
      return svc.status === 'running' && svc.pid !== before.pid;
    }, 5000);
  });

  test('a stopped service always starts on redeploy, even with an identical hash and env', async () => {
    const client = computeClient({ registryRoot });
    const artifactDir = writeBootstrap(SERVING_BOOTSTRAP);
    const reserved = await client.ensureService('app-e', 'web');
    const env = baseEnv({ PORT: String(reserved.port), ...servingBootstrapEnv('v1') });
    const deployment = {
      address: 'app-e.web',
      artifactDir,
      artifactHash: 'h',
      env,
      port: reserved.port,
    };

    await client.putDeployment('app-e', 'web', deployment);
    await waitFor(async () => (await deployedService('app-e', 'web')).status === 'running', 5000);

    await client.stopApp('app-e');
    await waitFor(async () => (await deployedService('app-e', 'web')).status === 'stopped', 5000);

    await client.putDeployment('app-e', 'web', deployment);
    await waitFor(async () => (await deployedService('app-e', 'web')).status === 'running', 5000);
  });
});

describe('crash supervision', () => {
  test('an unexpected crash goes to backoff and restarts after the pinned 1s·2ⁿ delay', async () => {
    const client = computeClient({ registryRoot });
    const artifactDir = writeBootstrap(CRASHING_BOOTSTRAP);
    const reserved = await client.ensureService('app-f', 'crasher');

    await client.putDeployment('app-f', 'crasher', {
      address: 'app-f.crasher',
      artifactDir,
      artifactHash: 'h',
      env: baseEnv(),
      port: reserved.port,
    });

    await waitFor(
      async () => (await deployedService('app-f', 'crasher')).status === 'backoff',
      3000,
    );

    // The first backoff step is the base case: 1s. Give it a comfortable
    // margin and confirm it actually restarts (the log shows the pinned
    // `[emulator] exited ... restarting in 1s` line), not just holds at
    // `backoff` forever.
    await waitFor(async () => {
      const text = await fetch(`${daemonUrl}/apps/app-f/services/crasher/logs`).then((r) =>
        r.text(),
      );
      return text.includes('[emulator] exited') && text.includes('restarting in 1s');
    }, 3000);
  }, 10_000);

  test('held after 5 consecutive fast crashes, and a redeploy clears held', async () => {
    const client = computeClient({ registryRoot });
    const crashingDir = writeBootstrap(CRASHING_BOOTSTRAP);
    const reserved = await client.ensureService('app-g', 'crasher');

    await client.putDeployment('app-g', 'crasher', {
      address: 'app-g.crasher',
      artifactDir: crashingDir,
      artifactHash: 'h',
      env: baseEnv(),
      port: reserved.port,
    });

    await waitFor(
      async () => (await deployedService('app-g', 'crasher')).status === 'held',
      20_000,
      250,
    );

    const stableDir = writeBootstrap(SERVING_BOOTSTRAP);
    await client.putDeployment('app-g', 'crasher', {
      address: 'app-g.crasher',
      artifactDir: stableDir,
      artifactHash: 'h2',
      env: baseEnv({ PORT: String(reserved.port), ...servingBootstrapEnv('recovered') }),
      port: reserved.port,
    });

    await waitFor(
      async () => (await deployedService('app-g', 'crasher')).status === 'running',
      5000,
    );
    const res = await waitForHttp(`http://127.0.0.1:${String(reserved.port)}`, 3000);
    expect(await res.text()).toBe('recovered');
  }, 30_000);
});

describe('stop truthfulness', () => {
  test('a child that ignores SIGTERM is only listed stopped once SIGKILL has actually landed', async () => {
    const client = computeClient({ registryRoot });
    const artifactDir = writeBootstrap(`process.on('SIGTERM', () => {});\n${SERVING_BOOTSTRAP}`);
    const reserved = await client.ensureService('app-i', 'stubborn');

    await client.putDeployment('app-i', 'stubborn', {
      address: 'app-i.stubborn',
      artifactDir,
      artifactHash: 'h',
      env: baseEnv({ PORT: String(reserved.port), ...servingBootstrapEnv('stubborn') }),
      port: reserved.port,
    });
    await waitFor(
      async () => (await deployedService('app-i', 'stubborn')).status === 'running',
      5000,
    );
    const pid = (await deployedService('app-i', 'stubborn')).pid;
    if (pid === undefined) throw new Error('expected the running service to report a pid');
    // `running` flips as soon as the child is spawned (spec: spawning IS
    // the observable action), before the child has actually finished
    // executing its own `process.on('SIGTERM', ...)` line — wait for the
    // server to actually answer, so the SIGTERM sent below truly lands
    // after the handler is installed, not racing bun's own startup.
    await waitForHttp(`http://127.0.0.1:${String(reserved.port)}`, 3000);

    // Poll the listing concurrently with the in-flight stop request: the
    // moment it ever reports `stopped`, the pid it just reported must
    // already be genuinely dead — never a state the listing predicted
    // ahead of the real OS process.
    let sawStoppedBeforeDeath = false;
    const watcher = (async () => {
      for (;;) {
        const svc = await deployedService('app-i', 'stubborn');
        if (svc.status === 'stopped') {
          if (isPidAlive(pid)) sawStoppedBeforeDeath = true;
          return;
        }
        await sleep(25);
      }
    })();

    const stopStart = Date.now();
    await client.stopApp('app-i');
    const stopElapsedMs = Date.now() - stopStart;
    await watcher;

    expect(sawStoppedBeforeDeath).toBe(false);
    expect(isPidAlive(pid)).toBe(false);
    // A SIGTERM-ignoring child only dies on SIGKILL, after the full pinned
    // grace period — confirms the stop actually waited it out rather than
    // reporting success early.
    expect(stopElapsedMs).toBeGreaterThanOrEqual(4900);
  }, 15_000);
});

describe('session resume (POST /apps/<app>/start)', () => {
  test('stop then start brings children back up on the same ports with new pids', async () => {
    const client = computeClient({ registryRoot });
    const oneDir = writeBootstrap(SERVING_BOOTSTRAP);
    const twoDir = writeBootstrap(SERVING_BOOTSTRAP);
    const one = await client.ensureService('app-j', 'web');
    const two = await client.ensureService('app-j', 'worker');

    await client.putDeployment('app-j', 'web', {
      address: 'app-j.web',
      artifactDir: oneDir,
      artifactHash: 'h',
      env: baseEnv({ PORT: String(one.port), ...servingBootstrapEnv('one') }),
      port: one.port,
    });
    await client.putDeployment('app-j', 'worker', {
      address: 'app-j.worker',
      artifactDir: twoDir,
      artifactHash: 'h',
      env: baseEnv({ PORT: String(two.port), ...servingBootstrapEnv('two') }),
      port: two.port,
    });
    await waitFor(async () => (await deployedService('app-j', 'web')).status === 'running', 5000);
    await waitFor(
      async () => (await deployedService('app-j', 'worker')).status === 'running',
      5000,
    );
    const pidsBefore = {
      web: (await deployedService('app-j', 'web')).pid,
      worker: (await deployedService('app-j', 'worker')).pid,
    };

    await client.stopApp('app-j');
    await waitFor(async () => (await deployedService('app-j', 'web')).status === 'stopped', 5000);
    await waitFor(
      async () => (await deployedService('app-j', 'worker')).status === 'stopped',
      5000,
    );

    await client.startApp('app-j');
    await waitFor(async () => (await deployedService('app-j', 'web')).status === 'running', 5000);
    await waitFor(
      async () => (await deployedService('app-j', 'worker')).status === 'running',
      5000,
    );

    const webAfter = await deployedService('app-j', 'web');
    const workerAfter = await deployedService('app-j', 'worker');
    expect(webAfter.pid).not.toBe(pidsBefore.web);
    expect(workerAfter.pid).not.toBe(pidsBefore.worker);
    expect(webAfter.port).toBe(one.port);
    expect(workerAfter.port).toBe(two.port);

    const resOne = await waitForHttp(`http://127.0.0.1:${String(one.port)}`, 3000);
    const resTwo = await waitForHttp(`http://127.0.0.1:${String(two.port)}`, 3000);
    expect(await resOne.text()).toBe('one');
    expect(await resTwo.text()).toBe('two');
  }, 20_000);

  test('a service with no stored deployment is skipped without error', async () => {
    const client = computeClient({ registryRoot });
    const deployedDir = writeBootstrap(SERVING_BOOTSTRAP);
    const deployed = await client.ensureService('app-k', 'web');
    await client.ensureService('app-k', 'never-deployed');

    await client.putDeployment('app-k', 'web', {
      address: 'app-k.web',
      artifactDir: deployedDir,
      artifactHash: 'h',
      env: baseEnv({ PORT: String(deployed.port), ...servingBootstrapEnv('deployed') }),
      port: deployed.port,
    });
    await waitFor(async () => (await deployedService('app-k', 'web')).status === 'running', 5000);
    await client.stopApp('app-k');
    await waitFor(async () => (await deployedService('app-k', 'web')).status === 'stopped', 5000);

    await client.startApp('app-k');

    await waitFor(async () => (await deployedService('app-k', 'web')).status === 'running', 5000);
    const neverDeployed = await deployedService('app-k', 'never-deployed');
    expect(neverDeployed.status).toBe('stopped');
    expect(neverDeployed.pid).toBeUndefined();
  }, 15_000);

  test('a held service resumes on start', async () => {
    const client = computeClient({ registryRoot });
    const crashingDir = writeBootstrap(CRASHING_BOOTSTRAP);
    const reserved = await client.ensureService('app-l', 'crasher');

    await client.putDeployment('app-l', 'crasher', {
      address: 'app-l.crasher',
      artifactDir: crashingDir,
      artifactHash: 'h',
      env: baseEnv(),
      port: reserved.port,
    });
    await waitFor(
      async () => (await deployedService('app-l', 'crasher')).status === 'held',
      20_000,
      250,
    );

    await client.startApp('app-l');

    // The crashing artifact is still what's stored, so the resumed child
    // crashes again shortly — but it takes 5 fresh fast exits to re-enter
    // `held` (the resume resets the counter), which takes multiple backoff
    // steps. Seeing anything other than `held` shortly after `/start`
    // proves the resume actually cleared it rather than no-op'ing on a
    // held service.
    await waitFor(
      async () => (await deployedService('app-l', 'crasher')).status !== 'held',
      2000,
      50,
    );
  }, 30_000);

  test('start on an already-running app is a no-op — pids unchanged', async () => {
    const client = computeClient({ registryRoot });
    const dir = writeBootstrap(SERVING_BOOTSTRAP);
    const reserved = await client.ensureService('app-m', 'web');

    await client.putDeployment('app-m', 'web', {
      address: 'app-m.web',
      artifactDir: dir,
      artifactHash: 'h',
      env: baseEnv({ PORT: String(reserved.port), ...servingBootstrapEnv('steady') }),
      port: reserved.port,
    });
    await waitFor(async () => (await deployedService('app-m', 'web')).status === 'running', 5000);
    const before = await deployedService('app-m', 'web');

    await client.startApp('app-m');

    const after = await deployedService('app-m', 'web');
    expect(after.status).toBe('running');
    expect(after.pid).toBe(before.pid);
  }, 10_000);
});

describe('log follow', () => {
  test('follow yields the child output plus [emulator] supervision lines', async () => {
    const client = computeClient({ registryRoot });
    const artifactDir = writeBootstrap(CRASHING_BOOTSTRAP);
    const reserved = await client.ensureService('app-h', 'crasher');

    const chunks: string[] = [];
    const controller = new AbortController();
    const following = (async () => {
      for await (const chunk of client.followLogs('app-h', 'crasher', controller.signal)) {
        chunks.push(chunk);
      }
    })().catch(() => undefined);

    await client.putDeployment('app-h', 'crasher', {
      address: 'app-h.crasher',
      artifactDir,
      artifactHash: 'h',
      env: baseEnv(),
      port: reserved.port,
    });

    await waitFor(() => chunks.join('').includes('[emulator] exited'), 5000, 100);
    controller.abort();
    await following;
  });

  test('?tail=N replays only the last N history lines before going live', async () => {
    const client = computeClient({ registryRoot });
    const artifactDir = writeBootstrap(LOGGING_BOOTSTRAP);
    const reserved = await client.ensureService('app-tail', 'logger');
    await client.putDeployment('app-tail', 'logger', {
      address: 'app-tail.logger',
      artifactDir,
      artifactHash: 't',
      env: baseEnv({ PORT: String(reserved.port), LINES: '10' }),
      port: reserved.port,
    });

    // All ten lines are on disk before the follow attaches — so what the
    // follow returns is backlog, not live output racing the loop.
    await waitFor(
      async () =>
        (
          await fetch(`${daemonUrl}/apps/app-tail/services/logger/logs`).then((r) => r.text())
        ).includes('line-10\n'),
      5000,
      100,
    );

    const chunks: string[] = [];
    const controller = new AbortController();
    await (async () => {
      for await (const chunk of client.followLogs('app-tail', 'logger', controller.signal, {
        tail: 3,
      })) {
        chunks.push(chunk);
        if (chunks.join('').includes('line-10\n')) break;
      }
    })();
    controller.abort();

    const seen = chunks.join('');
    expect(seen).toContain('line-8\n');
    expect(seen).toContain('line-10\n');
    expect(seen).not.toContain('line-7\n');
    expect(seen).not.toContain('line-1\n');
  }, 15_000);
});
