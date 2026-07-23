/**
 * Local postgres-cluster providers (local-dev spec § 4): `Database` and
 * `Connection` become clients of the ORM CLI's local Postgres (`prisma dev`)
 * — one named, detached instance per `Database` resource. `PgWarm` and
 * `PnMigration` are NOT here; the hosted ones run unchanged against
 * whichever URL they are handed.
 */
import { spawnSync } from 'node:child_process';
import * as net from 'node:net';
import type { DevProvidersInput } from '@internal/core/config';
import * as Provider from 'alchemy/Provider';
import * as Effect from 'effect/Effect';
import type * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';
import { Connection } from '../postgres/Connection.ts';
import { Database } from '../postgres/Database.ts';
import { appNameOf } from './app-name.ts';
import { postgresStore } from './dev-store.ts';
import { resolveLocalBin } from './resolve-bin.ts';
import { combinedOutput } from './spawn-utils.ts';

const TCP_PROBE_TIMEOUT_MS = 500;
const RESTART_PROBE_BUDGET_MS = 10_000;
const RESTART_PROBE_INTERVAL_MS = 500;

/** Lowercases and collapses every run of non-`[a-z0-9]` chars to a single `-`. */
export function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

/** `pcdev-<app>-<database-id>`, each piece slugged independently, trimmed to 63 chars. */
export function instanceName(app: string, databaseId: string): string {
  return `pcdev-${slug(app)}-${slug(databaseId)}`.slice(0, 63);
}

function noPrismaBinError(): Error {
  return new Error(
    "local dev needs the prisma CLI for its local Postgres emulator ('prisma dev') — add " +
      '"prisma" to your app\'s devDependencies.',
  );
}

/** Masks every connection-URL credential in captured CLI output before it is ever embedded in a thrown message — the no-value-logging contract (behavior contracts) applies to diagnostics too. */
function sanitizeOutput(output: string): string {
  return output.replace(/:\/\/([^:@/\s]+):[^@/\s]+@/g, '://$1:***@');
}

function couldNotReadUrlError(instance: string, output: string): Error {
  return new Error(
    `could not read the database URL from "prisma dev --name ${instance} --detach"; output was: ${sanitizeOutput(output)}`,
  );
}

function didNotComeBackError(instance: string, host: string, port: number): Error {
  return new Error(
    `the local Postgres instance "${instance}" did not come back on ${host}:${port} — run ` +
      '`prisma dev rm <instance>` and retry (or `prisma-composer dev --fresh`).',
  );
}

function lastNonEmptyLine(output: string): string | undefined {
  const lines = output.split('\n').map((line) => line.trim());
  return [...lines].reverse().find((line) => line.length > 0);
}

function probeTcpOnce(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      finish(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      finish(false);
    });
  });
}

async function probeTcpUntil(
  host: string,
  port: number,
  budgetMs: number,
  intervalMs: number,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (await probeTcpOnce(host, port, TCP_PROBE_TIMEOUT_MS)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function hostPortOf(url: string): { host: string; port: number } {
  const parsed = new URL(url);
  return { host: parsed.hostname, port: Number.parseInt(parsed.port, 10) };
}

async function createInstance(prismaBin: string, instance: string): Promise<string> {
  const result = spawnSync(prismaBin, ['dev', '--name', instance, '--detach'], {
    encoding: 'utf8',
  });
  const output = combinedOutput(result);
  const url = lastNonEmptyLine(output);
  if (url === undefined || result.status !== 0) throw couldNotReadUrlError(instance, output);
  return url;
}

async function startInstance(prismaBin: string, instance: string): Promise<void> {
  spawnSync(prismaBin, ['dev', 'start', instance], { encoding: 'utf8' });
}

/**
 * Ensures the named `prisma dev` instance is up and returns its URL,
 * following the pinned sequence: create on first sight; TCP-probe the
 * recorded URL; `start` + re-probe if it went cold (a reboot, a manual
 * `prisma dev stop`).
 */
async function ensurePostgresInstance(
  devDir: string,
  prismaBin: string,
  instance: string,
): Promise<string> {
  const store = postgresStore(devDir);
  const existing = (await store.read())[instance];

  if (existing === undefined) {
    const url = await createInstance(prismaBin, instance);
    await store.update((current) => ({ ...current, [instance]: { instance, url } }));
    return url;
  }

  const { host, port } = hostPortOf(existing.url);
  if (await probeTcpOnce(host, port, TCP_PROBE_TIMEOUT_MS)) return existing.url;

  await startInstance(prismaBin, instance);
  const backUp = await probeTcpUntil(
    host,
    port,
    RESTART_PROBE_BUDGET_MS,
    RESTART_PROBE_INTERVAL_MS,
  );
  if (!backUp) throw didNotComeBackError(instance, host, port);
  return existing.url;
}

/**
 * `Database` → a named `prisma dev` instance. Bin resolution walks up from
 * `process.cwd()` — the one place a local provider legitimately reads it,
 * since finding the app's own installed `prisma` is inherently cwd-relative.
 */
export function LocalDatabaseProvider(
  input: DevProvidersInput,
): Layer.Layer<Provider.Provider<Database>> {
  const service: Provider.ProviderService<Database> = {
    list: () => Effect.succeed([]),
    reconcile: ({ news }) =>
      Effect.tryPromise({
        try: async () => {
          const app = appNameOf(input.container);
          const prismaBin = resolveLocalBin(process.cwd(), 'prisma');
          if (prismaBin === undefined) throw noPrismaBinError();
          const instance = instanceName(app, news.name);
          await ensurePostgresInstance(input.devDir, prismaBin, instance);
          return { id: instance, name: news.name };
        },
        catch: (cause) => cause,
      }),
    delete: () => Effect.void,
  };
  return Provider.effect(Database, Effect.succeed(service));
}

function noRecordedInstanceError(databaseId: string): Error {
  return new Error(
    `no local Postgres instance recorded for databaseId "${databaseId}" — the Database provider ` +
      'did not run; converge is corrupt (try --fresh).',
  );
}

/** `Connection` → the recorded instance's URL, looked up by the Database attributes' `id` (the instance name). */
export function LocalConnectionProvider(
  input: DevProvidersInput,
): Layer.Layer<Provider.Provider<Connection>> {
  const service: Provider.ProviderService<Connection> = {
    list: () => Effect.succeed([]),
    reconcile: ({ news }) =>
      Effect.tryPromise({
        try: async () => {
          const entries = Object.values(await postgresStore(input.devDir).read());
          const found = entries.find((entry) => entry.instance === news.databaseId);
          if (found === undefined) throw noRecordedInstanceError(news.databaseId);
          return { id: found.instance, connectionString: Redacted.make(found.url) };
        },
        catch: (cause) => cause,
      }),
    delete: () => Effect.void,
  };
  return Provider.effect(Connection, Effect.succeed(service));
}
