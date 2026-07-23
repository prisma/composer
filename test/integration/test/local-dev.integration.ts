/**
 * The S4 integration proof (local-dev spec, plan.md's S4 outcome; no CLI —
 * the `prisma-composer dev` command itself is S5's scope): a fixture
 * topology (compute × 2, postgres, bucket) lowered with `dev: true` and
 * driven through the real `alchemy` binary against a hand-written stack
 * module (S5 owns `generate-dev-stack.ts`; this test hand-writes the
 * equivalent per spec § 6's template).
 *
 * Only `@prisma/composer`/`@prisma/composer-prisma-cloud` (9-public) are
 * imported (ADR-0028: examples/website/test import only the published
 * surface) — the emulator daemons and the dev-instance store are verified
 * through their DOCUMENTED wire protocol and on-disk file contracts (plain
 * `fetch()` + `fs.readFileSync`), never by importing `@internal/dev-emulators`
 * or `@internal/lowering` directly.
 *
 * The Compute/buckets emulators are the real, machine-global daemon programs
 * a real `prisma-composer dev` session would spawn (D4) — there is no way to
 * redirect them to an isolated registry from here: `ensureDaemon`'s own
 * `{registryRoot}` override is real, but reaching it would mean importing
 * `@internal/dev-emulators` directly, which a test importing only 9-public
 * cannot do, and `DevEmulatorsInput`/`DevProvidersInput` (the public surface)
 * carry no such field by design — dev's local providers are never meant to
 * target anything but the one real registry. (A `$HOME` redirect was tried
 * and does NOT work: bun's `os.homedir()` does not observe an in-process
 * `process.env.HOME` mutation made after startup, and a spawned child's
 * `os.homedir()` was confirmed — by checking the real
 * `~/.prisma-composer/emulators` after a run — to resolve the real home
 * regardless of the overridden env passed to `spawnSync`.) This test
 * therefore records whether each daemon was ALREADY running before it acts
 * (a baseline check) and only stops the ones it caused to start; every
 * app-scoped record is removed at the end regardless, through the
 * extension's own `dev.teardown`, and every `prisma dev` instance this test
 * created is removed too.
 *
 * WHY THIS IS A STANDALONE SCRIPT, NOT A `bun:test` FILE:
 *
 * `bun test` was tried first. Under `bun test` specifically,
 * `LocalDatabaseProvider`'s `prisma dev --name <x> --detach` subprocess
 * (spawned from deep inside the alchemy child's own Effect runtime) runs and
 * genuinely creates the instance, but its stdout is silently lost by the
 * calling `spawnSync`, so the first converge failed with "could not read the
 * database URL ... output was:" (empty). This was confirmed NOT a defect in
 * the local providers by rigorous empirical isolation: the identical stack
 * file, converged with the identical `alchemy` binary and args, succeeds
 * every time — "Done: 40 succeeded", full SERVING proof, correct HTTP
 * round-trip — under a plain shell, under `bun run <script>.ts` (this file),
 * and under plain `node`. Every other variable was ruled out (nesting depth,
 * `stdio` pipe vs. file-descriptor redirect, `detached: true`) — the one
 * variable that mattered was whether the process tree's ROOT ancestor is
 * `bun test`. Rather than work around that with an unrelated subprocess this
 * test doesn't control, the test itself is driven as a plain script (this
 * file) with hand-rolled asserts and `process.exitCode`, invoked by
 * `package.json`'s `test` script as `bun run test/local-dev.integration.ts`
 * — same `bun` runtime, same file-descriptor-redirected stdio and bounded
 * timeouts as before, just not started via `bun test`'s own harness.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { Load } from '@prisma/composer';
import type {
  ContainerInstance,
  DevAttachment,
  ExtensionDescriptor,
} from '@prisma/composer/config';
import { containerEnv, DEV_DIR } from '@prisma/composer/config';
import { nodeBuild } from '@prisma/composer/node/control';
import { prismaCloud } from '@prisma/composer-prisma-cloud/control';
import bgService from './fixtures/local-dev/bg-service.ts';
import appModule from './fixtures/local-dev/module.ts';
import webService from './fixtures/local-dev/web-service.ts';

// ——— Minimal plain-assert harness (no bun:test / describe / expect). Every
// assertion failure throws, caught by main()'s try/finally below, which
// prints the message and sets a nonzero exit code — no test runner needed.

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (!same) {
    throw new Error(
      `assertion failed: ${message}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`,
    );
  }
}

const APP_NAME = 'localdevs4fixture';
const integrationDir = path.resolve(import.meta.dir, '..');
const fixtureDir = path.join(integrationDir, 'test', 'fixtures', 'local-dev');
const devDir = path.join(fixtureDir, DEV_DIR);
const stackDir = devDir;
const stackFile = path.join(stackDir, 'alchemy.run.ts');
const stackFileRel = path.relative(fixtureDir, stackFile);
const configFile = path.join(fixtureDir, 'dev-config.ts');
const webEntryFile = path.join(fixtureDir, 'built', 'web-server.mjs');
const logDir = path.join(devDir, 'logs');
const ALCHEMY_TIMEOUT_MS = 60_000;

let convergeCount = 0;

function alchemyBin(): string {
  let dir = integrationDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', '.bin', 'alchemy');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`could not find node_modules/.bin/alchemy above ${integrationDir}`);
    }
    dir = parent;
  }
}

function relImportSpecifier(fromDir: string, toFile: string): string {
  const rel = path.relative(fromDir, toFile).split(path.sep).join('/');
  return rel.startsWith('.') ? rel : `./${rel}`;
}

interface FixtureBundle {
  readonly dir: string;
  readonly entry: string;
}

async function assembleFixture(): Promise<Record<string, FixtureBundle>> {
  const build = nodeBuild();
  const buildDescriptor = build.nodes['node'];
  if (buildDescriptor === undefined || buildDescriptor.kind !== 'build') {
    throw new Error('nodeBuild() has no "node" build descriptor');
  }
  const web = await buildDescriptor.assemble({
    build: webService.build,
    address: 'web',
    cwd: fixtureDir,
  });
  const bkg = await buildDescriptor.assemble({
    build: bgService.build,
    address: 'bkg',
    cwd: fixtureDir,
  });
  return { web, bkg };
}

function renderDevStackFile(bundles: Record<string, FixtureBundle>): string {
  const configImport = relImportSpecifier(stackDir, configFile);
  const appImport = relImportSpecifier(stackDir, path.join(fixtureDir, 'module.ts'));
  const bundleLines = Object.entries(bundles)
    .map(
      ([id, b]) =>
        `    ${JSON.stringify(id)}: { dir: ${JSON.stringify(b.dir)}, entry: ${JSON.stringify(b.entry)} },`,
    )
    .join('\n');
  return `// Hand-written for the S4 integration proof — S5 owns generate-dev-stack.ts.
import { lower } from '@prisma/composer/deploy';
import { localState } from 'alchemy/State/LocalState';
import config from ${JSON.stringify(configImport)};
import app from ${JSON.stringify(appImport)};

export default lower(app, config, {
  name: ${JSON.stringify(APP_NAME)},
  bundles: {
${bundleLines}
  },
  dev: true,
  state: localState(),
});
`;
}

/**
 * Runs one `alchemy deploy` against the hand-written dev stack file, exactly
 * as a real dev session would (--stage dev, always — D3), against the one
 * real, machine-global emulator registry.
 *
 * stdout/stderr are redirected straight to a log FILE (raw file descriptors,
 * not Node's `encoding: 'utf8'` pipe-and-buffer capture) — confirmed live
 * that piped capture silently loses output from a deeply nested grandchild
 * (alchemy's own foreground-child watchdog, in turn running the stack file,
 * in turn shelling out to `prisma dev --detach`) specifically when the
 * OUTER process is `bun test`; the identical command run from a plain shell,
 * or with output going straight to a file, does not lose it. Bounded (never
 * a silent indefinite hang — the chief risk is `prisma dev --detach`
 * downloading engines on first use with no visible output) regardless.
 */
function runAlchemyDeploy(containerEnvVars: Readonly<Record<string, string>>): {
  status: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  logFile: string;
} {
  convergeCount += 1;
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `converge-${convergeCount}.log`);
  const logFd = fs.openSync(logFile, 'w');
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(alchemyBin(), ['deploy', stackFileRel, '--yes', '--stage', 'dev'], {
      cwd: fixtureDir,
      stdio: ['ignore', logFd, logFd],
      timeout: ALCHEMY_TIMEOUT_MS,
      env: { ...process.env, ...containerEnvVars },
    });
  } finally {
    fs.closeSync(logFd);
  }
  const output = fs.readFileSync(logFile, 'utf8');
  return {
    status: result.status,
    timedOut: result.signal === 'SIGTERM',
    stdout: output,
    stderr: '',
    logFile,
  };
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

interface EmulatorRegistryEntry {
  readonly pid: number;
  readonly port: number;
}

function isRegistryEntry(value: unknown): value is EmulatorRegistryEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    'pid' in value &&
    typeof value.pid === 'number' &&
    'port' in value &&
    typeof value.port === 'number'
  );
}

/** The documented on-disk registry contract (spec § 2 daemon.ts) — read directly, never through @internal/dev-emulators. The one real, machine-global root, exactly like `defaultRegistryRoot()` resolves. */
function emulatorRegistryRoot(): string {
  return path.join(os.homedir(), '.prisma-composer', 'emulators');
}

function readEmulatorEntry(name: 'compute' | 'buckets'): EmulatorRegistryEntry | undefined {
  const parsed = readJson(path.join(emulatorRegistryRoot(), `${name}.json`));
  return isRegistryEntry(parsed) ? parsed : undefined;
}

interface ServiceInfo {
  readonly id: string;
  readonly address: string;
  readonly port: number;
  readonly url: string;
  readonly status: string;
  readonly pid?: number;
}

/** The documented Compute-emulator wire protocol (spec § 2 compute-main.ts) — plain fetch, never the typed client. */
async function listComputeServices(): Promise<readonly ServiceInfo[]> {
  const entry = readEmulatorEntry('compute');
  if (entry === undefined) throw new Error('compute emulator registry entry not found');
  const res = await fetch(`http://127.0.0.1:${entry.port}/apps/${APP_NAME}/services`);
  if (!res.ok) throw new Error(`compute emulator listServices failed: ${res.status}`);
  return (await res.json()) as ServiceInfo[];
}

/**
 * Polls `fn` until it returns something other than `undefined`, or throws
 * after `timeoutMs`. A freshly-deployed service is not instantaneously
 * reachable — its child process needs a moment to start listening, and under
 * heavy machine load (many concurrent processes competing for CPU) that
 * moment can stretch well past a single attempt. A real dev session's own
 * client (a browser, curl) would retry the same way; this mirrors that
 * rather than asserting on the very first attempt.
 */
async function waitFor<T>(
  fn: () => Promise<T | undefined>,
  timeoutMs: number,
  intervalMs = 250,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const result = await fn();
      if (result !== undefined) return result;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      throw lastError instanceof Error
        ? lastError
        : new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function probeTcp(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.end();
      resolve(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function main(): Promise<void> {
  console.log(
    'local dev (S4): compute + postgres + bucket, lowered with dev: true through a real alchemy converge',
  );

  let descriptor: ExtensionDescriptor | undefined;
  let devContainer: ContainerInstance | undefined;
  let attachment: DevAttachment | undefined;
  // Baseline, read BEFORE this test touches anything — only a daemon this
  // test itself caused to start gets stopped at the end; a daemon another
  // real session already had running is left alone (D4/D12: --fresh, and by
  // extension this test, never touches the machine-global daemons another
  // app may be using).
  let computePreExisting = false;
  let bucketsPreExisting = false;

  fs.rmSync(path.join(fixtureDir, '.prisma-composer'), { recursive: true, force: true });
  fs.rmSync(path.join(fixtureDir, '.alchemy'), { recursive: true, force: true });
  computePreExisting = readEmulatorEntry('compute') !== undefined;
  bucketsPreExisting = readEmulatorEntry('buckets') !== undefined;

  try {
    // 1. Construct the extension with NO PRISMA_* present — proves the
    // scrubbed-env construction requirement through the real factory.
    const savedWorkspaceId = process.env['PRISMA_WORKSPACE_ID'];
    const savedServiceToken = process.env['PRISMA_SERVICE_TOKEN'];
    const savedRegion = process.env['PRISMA_REGION'];
    delete process.env['PRISMA_WORKSPACE_ID'];
    delete process.env['PRISMA_SERVICE_TOKEN'];
    delete process.env['PRISMA_REGION'];
    try {
      descriptor = prismaCloud();
    } finally {
      if (savedWorkspaceId !== undefined) process.env['PRISMA_WORKSPACE_ID'] = savedWorkspaceId;
      if (savedServiceToken !== undefined) process.env['PRISMA_SERVICE_TOKEN'] = savedServiceToken;
      if (savedRegion !== undefined) process.env['PRISMA_REGION'] = savedRegion;
    }
    assert(descriptor.dev !== undefined, 'prismaCloud() must declare a dev descriptor');

    // 2. The dev container — a purely local identity, no platform call.
    const dev = descriptor.dev;
    if (dev === undefined) throw new Error('expected a dev descriptor');
    devContainer = await dev.container.ensure({ appName: APP_NAME, stage: undefined });

    // 3. Load the graph (mirrors the CLI pipeline's own Load step).
    const graph = Load(appModule, { id: APP_NAME });

    // 4. Assemble both services (real build adapter, hand-written "built" entries).
    const bundles = await assembleFixture();

    // 5. Preflight — this fixture binds no secrets/env-params; must be a no-op.
    if (dev.preflight !== undefined) {
      await dev.preflight({ graph, container: devContainer, stage: undefined });
    }

    // 6. Emulators — ensures compute always, buckets because the graph has
    // an `s3`-kinded resource.
    if (dev.emulators !== undefined) {
      await dev.emulators({ graph, container: devContainer, devDir });
    }
    assert(readEmulatorEntry('compute') !== undefined, 'compute emulator must be registered');
    assert(readEmulatorEntry('buckets') !== undefined, 'buckets emulator must be registered');

    // 7. Write the dev stack file and converge through the REAL alchemy binary.
    fs.mkdirSync(stackDir, { recursive: true });
    fs.writeFileSync(stackFile, renderDevStackFile(bundles));
    const containerEnvVars = containerEnv(new Map([[descriptor.id, devContainer]]));
    const first = runAlchemyDeploy(containerEnvVars);
    if (first.status !== 0) {
      throw new Error(
        `alchemy deploy (first converge) failed (timedOut=${String(first.timedOut)}); see ${first.logFile}:\n${first.stdout}\n${first.stderr}`,
      );
    }

    // 8. SERVING: attach and HTTP round-trip the web service. A freshly
    // deployed child needs a moment to start listening, so both the health
    // round-trip and the emulator's own "running" status are polled with a
    // bounded deadline rather than asserted on the very first attempt.
    attachment = await dev.attach({ container: devContainer, devDir });
    const endpoints = await attachment.endpoints();
    const web = endpoints.find((e) => e.address === 'web');
    assert(web !== undefined, 'the web service must appear in attach().endpoints()');
    if (web === undefined) throw new Error('unreachable');
    const health = (await waitFor(
      () => fetch(`${web.url}/health`).then((r) => (r.ok ? r.json() : undefined)),
      15_000,
    )) as { ok: boolean; version: string; db: boolean; store: boolean; portEnv: string | null };
    assertEqual(
      { ok: health.ok, version: health.version, db: health.db, store: health.store },
      { ok: true, version: 'v1', db: true, store: true },
      'the web service /health round-trip',
    );

    // 9. Emulator listing correct: both services running, stable ports/pids present.
    const { webInfo, bkgInfo } = await waitFor(async () => {
      const services = await listComputeServices();
      const web = services.find((s) => s.address === 'web');
      const bkg = services.find((s) => s.address === 'bkg');
      if (web?.status === 'running' && bkg?.status === 'running') {
        return { webInfo: web, bkgInfo: bkg };
      }
      return undefined;
    }, 15_000);
    assertEqual(webInfo.status, 'running', 'web service status');
    assertEqual(bkgInfo.status, 'running', 'bkg service status');
    assert(typeof webInfo.pid === 'number', 'web service must report a pid');
    assert(typeof bkgInfo.pid === 'number', 'bkg service must report a pid');

    // 10. env store correct: poison DATABASE_URL rows. The port-override row
    // (COMPOSER_<ADDRESS>_PORT) is deliberately NEVER persisted to env.json
    // (local-dev spec § 4: "Ports live nowhere here" — the Deployment
    // provider materializes it fresh into each deployment's own env, in
    // memory, and never writes it back) — so it is verified through the
    // fixture's own /health response (captured above, before webInfo existed
    // to compare against) rather than by reading env.json for a key it never
    // receives.
    const env = readJson(path.join(devDir, 'env.json')) as Record<string, string>;
    assertEqual(env['DATABASE_URL'], '-', 'env.json DATABASE_URL is poisoned');
    assertEqual(env['DATABASE_URL_POOLED'], '-', 'env.json DATABASE_URL_POOLED is poisoned');
    assertEqual(
      health.portEnv,
      JSON.stringify(webInfo.port),
      'the deployed web child carries COMPOSER_WEB_PORT = the emulator-assigned port, JSON-encoded',
    );

    // secrets.json: no secrets/params in this fixture, so it is either
    // absent or empty — never populated.
    const secrets = readJson(path.join(devDir, 'secrets.json'));
    assert(
      secrets === undefined || Object.keys(secrets as object).length === 0,
      'secrets.json must be absent or empty for this fixture',
    );

    // 11. postgres.json + a real, running `prisma dev` instance. Keyed by the
    // instance name itself (`pcdev-<app>-<node>`), not the bare node id.
    const postgres = readJson(path.join(devDir, 'postgres.json')) as Record<
      string,
      { instance: string; url: string }
    >;
    const dbEntry = postgres['pcdev-localdevs4fixture-appdb'];
    assertEqual(dbEntry?.instance, 'pcdev-localdevs4fixture-appdb', 'postgres.json instance name');
    const dbUrl = new URL(dbEntry?.url ?? '');
    const dbReachable = await probeTcp(dbUrl.hostname, Number(dbUrl.port), 2000);
    assert(
      dbReachable,
      `the prisma dev instance must be reachable at ${dbUrl.hostname}:${dbUrl.port}`,
    );

    // 12. Second converge, unchanged build: full no-op — same pids.
    const second = runAlchemyDeploy(containerEnvVars);
    if (second.status !== 0) {
      throw new Error(
        `alchemy deploy (no-op converge) failed (timedOut=${String(second.timedOut)}); see ${second.logFile}:\n${second.stdout}\n${second.stderr}`,
      );
    }
    const servicesAfterNoop = await waitFor(async () => {
      const services = await listComputeServices();
      const web = services.find((s) => s.address === 'web');
      const bkg = services.find((s) => s.address === 'bkg');
      return web?.pid !== undefined && bkg?.pid !== undefined ? services : undefined;
    }, 15_000);
    assertEqual(
      servicesAfterNoop.find((s) => s.address === 'web')?.pid,
      webInfo.pid,
      'web pid stable across a no-op converge',
    );
    assertEqual(
      servicesAfterNoop.find((s) => s.address === 'bkg')?.pid,
      bkgInfo.pid,
      'bkg pid stable across a no-op converge',
    );

    // 13. Changed artifact (web only): restarts exactly that service.
    const original = fs.readFileSync(webEntryFile, 'utf8');
    fs.writeFileSync(
      webEntryFile,
      original.replace("const VERSION = 'v1';", "const VERSION = 'v2';"),
    );
    try {
      const rebundled = await assembleFixture();
      fs.writeFileSync(stackFile, renderDevStackFile(rebundled));
      const third = runAlchemyDeploy(containerEnvVars);
      if (third.status !== 0) {
        throw new Error(
          `alchemy deploy (changed-artifact converge) failed (timedOut=${String(third.timedOut)}); see ${third.logFile}:\n${third.stdout}\n${third.stderr}`,
        );
      }

      const servicesAfterChange = await waitFor(async () => {
        const services = await listComputeServices();
        const web = services.find((s) => s.address === 'web');
        const bkg = services.find((s) => s.address === 'bkg');
        // The web pid must have moved on (restarted); bkg's must be present
        // and unchanged — wait for both to settle before asserting.
        return web?.pid !== undefined && web.pid !== webInfo.pid && bkg?.pid !== undefined
          ? services
          : undefined;
      }, 15_000);
      const webAfterChange = servicesAfterChange.find((s) => s.address === 'web');
      const bkgAfterChange = servicesAfterChange.find((s) => s.address === 'bkg');
      assert(webAfterChange?.pid !== webInfo.pid, 'web service must restart on a changed artifact');
      assertEqual(bkgAfterChange?.pid, bkgInfo.pid, 'bkg service must stay untouched');

      const webAfterChangeUrl = endpoints.find((e) => e.address === 'web')?.url;
      const healthAfterChange = await waitFor(
        () => fetch(`${webAfterChangeUrl}/health`).then((r) => (r.ok ? r.json() : undefined)),
        15_000,
      );
      assertEqual(
        (healthAfterChange as { version: string }).version,
        'v2',
        'web /health reflects v2',
      );
    } finally {
      fs.writeFileSync(webEntryFile, original);
    }

    console.log('PASS: local dev (S4) integration proof');
  } finally {
    await attachment?.stopServices().catch(() => undefined);

    // App-scoped teardown through the extension's own public dev.teardown —
    // never stops the daemons themselves (D4/D12), just this app's records
    // and its `prisma dev` instance(s).
    if (descriptor?.dev?.teardown !== undefined) {
      await descriptor.dev
        .teardown({ container: devContainer, stage: undefined })
        .catch(() => undefined);
    }

    // Stop only the daemon(s) THIS run caused to start (per the baseline
    // above) — never a real, pre-existing machine-global daemon. The pid
    // comes straight from the documented registry file.
    for (const [name, preExisting] of [
      ['compute', computePreExisting],
      ['buckets', bucketsPreExisting],
    ] as const) {
      if (preExisting) continue;
      const entry = readEmulatorEntry(name);
      if (entry === undefined) continue;
      try {
        process.kill(entry.pid, 'SIGTERM');
      } catch {
        // already gone
      }
      fs.rmSync(path.join(emulatorRegistryRoot(), `${name}.json`), { force: true });
      fs.rmSync(path.join(emulatorRegistryRoot(), name), { recursive: true, force: true });
      fs.rmSync(path.join(emulatorRegistryRoot(), `${name}.log`), { force: true });
    }

    // `.prisma-composer/dev/logs/` is deliberately left in place (wiped by
    // the NEXT run instead) so a converge log survives a failure for
    // post-mortem inspection; both dirs are repo-gitignored either way.
  }
}

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exitCode = 1;
  });
