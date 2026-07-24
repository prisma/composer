/** Shared test-only helpers: temp dirs, fixture bootstraps, small async waits. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import getPort, { portNumbers } from 'get-port';
import type { ComputeClient } from '../client.ts';
import { type DaemonName, ensureDaemon } from '../daemon.ts';

/**
 * `ensureDaemon` no longer resolves its own entry (spec § 2's publish note —
 * the caller does, so the published dist can point at its own public
 * subpaths). In-repo tests resolve the in-repo `@internal/dev-emulators/*-main`
 * subpaths directly — the same resolution `daemon.ts` used to do internally.
 */
export function entryFor(name: DaemonName): string {
  return fileURLToPath(import.meta.resolve(`@internal/dev-emulators/${name}-main`));
}

/**
 * The `@prisma/dev` module path a real app would resolve from its own
 * `node_modules` and pass as `prismaDevModulePath` — resolved here from
 * this workspace's own `node_modules`, where it's a devDependency of this
 * package for tests only (the daemon itself has no dependency on it; see
 * `postgres-main.ts`'s module doc).
 */
export function prismaDevModulePath(): string {
  return fileURLToPath(import.meta.resolve('@prisma/dev'));
}

export function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dev-emulators-${prefix}-`));
}

/** Writes a `bootstrap.js` a real `bun` process can run, into a fresh temp artifact dir. */
export function writeBootstrap(source: string): string {
  const dir = tempDir('artifact');
  fs.writeFileSync(path.join(dir, 'bootstrap.js'), source);
  return dir;
}

/**
 * A tiny HTTP server on `process.env['PORT']` that answers with
 * `process.env['FIXTURE_BODY']`. Fixed source, no interpolation of any
 * kind — the response body is never baked into generated code at all; it
 * travels to the child at spawn time via its own `env`, the same way
 * `PORT` already does. Pair with `servingBootstrapEnv(body)` to supply the
 * value.
 */
export const SERVING_BOOTSTRAP =
  "const body = process.env['FIXTURE_BODY'] ?? '';\n" +
  "Bun.serve({ port: Number(process.env['PORT']), fetch: () => new Response(body) });\n" +
  "console.log('booted: ' + body);\n";

/** The env entry `SERVING_BOOTSTRAP` reads its response body from. */
export function servingBootstrapEnv(body: string): { FIXTURE_BODY: string } {
  return { FIXTURE_BODY: body };
}

/** Exits immediately with a nonzero code — a fast-crashing service. */
export const CRASHING_BOOTSTRAP = 'process.exit(1);\n';

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await sleep(intervalMs);
  }
}

/**
 * `compute-main` marks a service `running` as soon as it spawns the child —
 * matching the spec (spawning IS the observable action) — not once the
 * child has finished booting and bound its own port. Tests that then fetch
 * the service's own HTTP server need to retry past that short boot window.
 */
export async function waitForHttp(url: string, timeoutMs: number): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await fetch(url);
    } catch (err) {
      if (Date.now() >= deadline) throw err;
      await sleep(100);
    }
  }
}

const DEFAULT_MIN_PORT = 4300;

/**
 * Starts a daemon on a FRESH `registryRoot`, steered away from any port near
 * the default range occupied by a process this test doesn't control —
 * another local dev-emulators daemon on this machine, another concurrent
 * test run. Those are invisible to both this test's own registry and to
 * ensureDaemon's port-uniqueness bookkeeping (each is scoped to its own
 * registryRoot), so left unhandled they make an unrelated external bind
 * failure look like this suite's own flake. Only for a registryRoot with no
 * daemon started yet — later calls on the same root should use
 * `ensureDaemon` directly.
 */
export async function ensureFreshDaemon(
  name: DaemonName,
  registryRoot: string,
): Promise<{ url: string }> {
  const freePort = await getPort({ port: portNumbers(DEFAULT_MIN_PORT, DEFAULT_MIN_PORT + 200) });
  fs.mkdirSync(registryRoot, { recursive: true });
  for (let port = DEFAULT_MIN_PORT; port < freePort; port++) {
    fs.writeFileSync(
      path.join(registryRoot, `fake-occupant-${String(port)}.json`),
      JSON.stringify({ pid: process.pid, port, version: 'fake', logPath: '/dev/null' }),
    );
  }
  return ensureDaemon(name, entryFor(name), { registryRoot });
}

const DEFAULT_MIN_SERVICE_PORT = 3000;

/**
 * Reserves dummy services on a fresh Compute daemon to push every REAL
 * service this test reserves afterward past any port near the default
 * service range already bound by a process outside this test's control —
 * unlike the daemon-registry case, a service's port is only chosen (never
 * verified against the real OS) at reservation time, so a service that
 * lands on a contended port fails to bind only once something actually
 * tries to `Bun.serve()` there.
 */
export async function skipContendedServicePorts(
  client: Pick<ComputeClient, 'ensureService'>,
  minPort: number = DEFAULT_MIN_SERVICE_PORT,
): Promise<void> {
  const freePort = await getPort({ port: portNumbers(minPort, minPort + 200) });
  for (let i = 0; i < freePort - minPort; i++) {
    await client.ensureService('port-skip', `dummy-${String(i)}`);
  }
}
