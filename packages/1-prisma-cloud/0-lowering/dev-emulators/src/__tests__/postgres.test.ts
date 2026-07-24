/**
 * The Postgres emulator (local-dev spec § 2 `postgres-main.ts`): ensure/
 * list/delete lifecycle, port stability with data intact across a daemon
 * restart, multi-app isolation, a bogus module path, and fresh-allocation
 * port retry. Every test uses a temp `registryRoot` and a real, distinct
 * app name so its instances (`pcdev-<app>-<id>`) never collide with real
 * `@prisma/dev` usage elsewhere on this machine, and every test cleans up
 * via `DELETE /apps/<app>` so it never leaves persisted PGlite data behind.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { deleteServer } from '@prisma/dev/internal/state';
import { Client as PgClient } from 'pg';
import { postgresClient } from '../client.ts';
import { stopDaemon } from '../daemon.ts';
import { instanceNameFor } from '../instance-name.ts';
import { ensureFreshDaemon, prismaDevModulePath, tempDir } from './helpers.ts';

let registryRoot: string;

beforeEach(() => {
  registryRoot = tempDir('postgres-registry');
});

afterEach(async () => {
  await stopDaemon('postgres', { registryRoot }).catch(() => undefined);
});

/** Occupies a real port with a plain TCP listener — a stand-in for "another Prisma Dev server already holds this port." */
function occupyPort(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('database lifecycle', () => {
  test('ensure, list, and delete a database', async () => {
    await ensureFreshDaemon('postgres', registryRoot);
    const client = postgresClient({ registryRoot });

    const ensured = await client.ensureDatabase('pgtest-lifecycle', 'appdb', prismaDevModulePath());
    expect(ensured.url).toMatch(/^postgres:\/\//);

    const listed = await client.listDatabases('pgtest-lifecycle');
    expect(listed).toHaveLength(1);
    const entry = listed[0];
    if (!entry) throw new Error('expected one listed database');
    expect(entry.id).toBe('appdb');
    expect(entry.url).toBe(ensured.url);
    expect(entry.instanceName).toBe('pcdev-pgtest-lifecycle-appdb');

    // A real connection actually works — this is a real Postgres server, not a stub.
    const pg = new PgClient({ connectionString: ensured.url });
    await pg.connect();
    const res = await pg.query('select 1 as one');
    expect(res.rows[0].one).toBe(1);
    await pg.end();

    await client.deleteApp('pgtest-lifecycle');
    expect(await client.listDatabases('pgtest-lifecycle')).toHaveLength(0);
  }, 30_000);

  test('ensure is idempotent — a second call returns the same URL without restarting', async () => {
    await ensureFreshDaemon('postgres', registryRoot);
    const client = postgresClient({ registryRoot });

    const first = await client.ensureDatabase('pgtest-idempotent', 'appdb', prismaDevModulePath());
    const second = await client.ensureDatabase('pgtest-idempotent', 'appdb', prismaDevModulePath());
    expect(second.url).toBe(first.url);

    await client.deleteApp('pgtest-idempotent');
  }, 30_000);
});

describe('port stability across a daemon restart', () => {
  test('a version-skew restart drops the in-process server; PUT brings it back on the SAME port with data intact', async () => {
    await ensureFreshDaemon('postgres', registryRoot);
    const client = postgresClient({ registryRoot });

    const first = await client.ensureDatabase('pgtest-restart', 'appdb', prismaDevModulePath());
    const firstPort = new URL(first.url.replace('postgres://', 'http://')).port;

    // Write a real row via a real `pg` connection before the restart.
    const writer = new PgClient({ connectionString: first.url });
    await writer.connect();
    await writer.query('drop table if exists restart_check');
    await writer.query('create table restart_check (id integer primary key)');
    await writer.query('insert into restart_check (id) values (1)');
    await writer.end();

    // A daemon restart (this package's own version-skew path drops the
    // in-process server): stop it outright and start a fresh one on the
    // SAME registryRoot — the persisted `apps.json` survives, the live
    // `@prisma/dev` server object does not. `stopDaemon` deletes the
    // DAEMON's own registry entry, so the outer daemon admin port is free
    // to land somewhere new on the next ensure — only the DATABASE port
    // (postgres-main's own persisted state) must stay put. A fresh client
    // re-resolves the (possibly new) daemon admin port; reusing the old
    // `client` would talk to a port nothing is listening on anymore.
    await stopDaemon('postgres', { registryRoot });
    await ensureFreshDaemonSamePort(registryRoot);
    const clientAfterRestart = postgresClient({ registryRoot });

    const second = await clientAfterRestart.ensureDatabase(
      'pgtest-restart',
      'appdb',
      prismaDevModulePath(),
    );
    const secondPort = new URL(second.url.replace('postgres://', 'http://')).port;
    expect(secondPort).toBe(firstPort);

    const reader = new PgClient({ connectionString: second.url });
    await reader.connect();
    const res = await reader.query('select id from restart_check');
    expect(res.rows).toEqual([{ id: 1 }]);
    await reader.end();

    await clientAfterRestart.deleteApp('pgtest-restart');
  }, 45_000);
});

/**
 * The daemon-port-retry test helper (`ensureFreshDaemon`) pre-seeds fake
 * registry occupants to steer a FRESH registryRoot away from shared-machine
 * contention. On a restart of an ALREADY-established registryRoot, the
 * daemon's own port is already persisted (frozen — spec § 2 step 5's
 * persisted-port case), so this just re-ensures directly without the
 * fresh-allocation dance `ensureFreshDaemon` does for a brand-new root.
 */
async function ensureFreshDaemonSamePort(root: string): Promise<void> {
  const { ensureDaemon } = await import('../daemon.ts');
  const { entryFor } = await import('./helpers.ts');
  await ensureDaemon('postgres', entryFor('postgres'), { registryRoot: root });
}

describe('multi-app isolation', () => {
  test("two apps' databases with the same id are distinct, non-colliding instances", async () => {
    await ensureFreshDaemon('postgres', registryRoot);
    const client = postgresClient({ registryRoot });

    const a = await client.ensureDatabase('pgtest-tenant-a', 'appdb', prismaDevModulePath());
    const b = await client.ensureDatabase('pgtest-tenant-b', 'appdb', prismaDevModulePath());
    expect(a.url).not.toBe(b.url);

    const aWriter = new PgClient({ connectionString: a.url });
    await aWriter.connect();
    await aWriter.query('create table if not exists tenant_marker (v text)');
    await aWriter.query("insert into tenant_marker (v) values ('tenant-a')");
    await aWriter.end();

    // Tenant B's own database never sees tenant A's table — genuinely
    // separate PGlite instances, not a shared one with namespacing.
    const bReader = new PgClient({ connectionString: b.url });
    await bReader.connect();
    const res = await bReader.query("select to_regclass('tenant_marker') as reg");
    expect(res.rows[0].reg).toBeNull();
    await bReader.end();

    await client.deleteApp('pgtest-tenant-a');
    await client.deleteApp('pgtest-tenant-b');
  }, 45_000);
});

describe('a bogus prismaDevModulePath', () => {
  test('surfaces 500 naming the resolution failure without leaking unrelated paths', async () => {
    await ensureFreshDaemon('postgres', registryRoot);
    const client = postgresClient({ registryRoot });

    const bogusPath = '/definitely/not/a/real/path/to/prisma-dev/index.js';
    await expect(client.ensureDatabase('pgtest-bogus', 'appdb', bogusPath)).rejects.toThrow();

    try {
      await client.ensureDatabase('pgtest-bogus', 'appdb', bogusPath);
      throw new Error('expected ensureDatabase to reject');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The client wraps the emulator's response as
      // `request to the local dev emulator failed (${status}): ${body}` —
      // assert the status explicitly, not just that SOME error was thrown.
      expect(message).toContain('(500)');
      expect(message).toContain('local dev needs @prisma/dev');
      expect(message).toContain(bogusPath);
      // No OTHER filesystem path leaks — e.g. a dynamic `import()`
      // failure's own message routinely names a SECOND path (the
      // importer's own internal location), which has no business in a
      // response body. Every MULTI-SEGMENT absolute-path-shaped substring
      // (2+ `/`-separated segments, so "@prisma/dev" itself doesn't count)
      // must be the one path the client itself supplied.
      const pathsInMessage = [...message.matchAll(/(?:\/[^\s"')/]+){2,}/g)].map((m) => m[0]);
      expect([...new Set(pathsInMessage)]).toEqual([bogusPath]);
    }
  }, 15_000);
});

describe('fresh-allocation port retry (spec § 2 step 5, applied to databasePort)', () => {
  test('a bind failure on a fresh allocation retries the next free port', async () => {
    await ensureFreshDaemon('postgres', registryRoot);
    const client = postgresClient({ registryRoot });

    // Occupy the FIRST candidate database port a fresh allocation would
    // pick, forcing the retry path.
    const squatter = await occupyPort(51_300);
    try {
      const ensured = await client.ensureDatabase('pgtest-retry', 'appdb', prismaDevModulePath());
      const port = Number(new URL(ensured.url.replace('postgres://', 'http://')).port);
      expect(port).toBeGreaterThan(51_300);

      const pg = new PgClient({ connectionString: ensured.url });
      await pg.connect();
      await pg.query('select 1');
      await pg.end();
    } finally {
      await closeServer(squatter);
    }

    await client.deleteApp('pgtest-retry');
  }, 30_000);
});

describe('instance name derivation is linear, not polynomial', () => {
  test('a pathological run of separators slugs correctly and stays fast', () => {
    const pathological = `a${'-'.repeat(10_000)}b`;

    const start = performance.now();
    const name = instanceNameFor(pathological, pathological);
    const elapsedMs = performance.now() - start;

    // A run of separators collapses to one `-`, same as any other run —
    // no special case for length. `pcdev-a-b-a-b`.slice(0, 63) is still
    // well within the cap, so nothing else about the shape changes.
    expect(name).toBe('pcdev-a-b-a-b');
    expect(elapsedMs).toBeLessThan(100);
  });
});

describe("a server that exists in @prisma/dev's records but not the daemon's", () => {
  test('a live server under the daemon-derived name is adopted, not restarted or deleted', async () => {
    // The daemon's own state and `@prisma/dev`'s records can disagree: a
    // daemon replaced for version skew, or a teardown that declined to
    // delete, leaves a server registered under a name the daemon has no
    // record of. Starting into that used to surface "already running" as a
    // 500 — and the recovery that deleted the state took the data (and the
    // daemon) with it.
    //
    // The foreign server runs in its OWN process, exactly as a leftover
    // from a previous daemon does. That is not incidental: the record names
    // its host's pid, and teardown stops an adopted server by that pid — so
    // a server started inside THIS test process would make the teardown
    // kill the test runner.
    const app = 'pgtest-adopt';
    const id = 'db';
    const instanceName = instanceNameFor(app, id);

    const scriptPath = path.join(tempDir('adopt-host'), 'host.mjs');
    fs.writeFileSync(
      scriptPath,
      `import { startPrismaDevServer } from ${JSON.stringify(pathToFileURL(prismaDevModulePath()).href)};
const server = await startPrismaDevServer({ name: ${JSON.stringify(instanceName)}, persistenceMode: 'stateful' });
console.log(server.database.connectionString);
setInterval(() => {}, 1 << 30);
`,
    );

    const host = spawn(process.execPath, [scriptPath], { stdio: ['ignore', 'pipe', 'inherit'] });
    const foreignUrl = await new Promise<string>((resolve, reject) => {
      let out = '';
      host.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString();
        const line = out.split('\n')[0];
        if (line !== undefined && out.includes('\n')) resolve(line.trim());
      });
      host.once('error', reject);
      host.once('exit', (code) => reject(new Error(`host exited early (${String(code)})`)));
    });

    try {
      await ensureFreshDaemon('postgres', registryRoot);
      const client = postgresClient({ registryRoot });

      const ensured = await client.ensureDatabase(app, id, prismaDevModulePath());

      // Adopted: the same live server, reachable — not a second one on a
      // different port, and not an error.
      expect(ensured.url).toBe(foreignUrl);
      const pg = new PgClient({ connectionString: ensured.url });
      await pg.connect();
      await pg.query('select 1');
      await pg.end();

      // And the daemon stayed up — the failure this guards against killed it.
      expect((await client.health()).version.length).toBeGreaterThan(0);

      await client.deleteApp(app);
    } finally {
      host.kill('SIGKILL');
      await deleteServer(instanceName).catch(() => undefined);
    }
  }, 60_000);
});

describe('concurrent ensures for different databases', () => {
  test('two databases requested at once both come up — starts are serialized', async () => {
    // An app converges its databases in parallel, so the daemon receives
    // simultaneous ensures for different names. `@prisma/dev`'s start is not
    // concurrency-safe within a process — two at once pick ports without
    // seeing each other and one fails — so the daemon runs starts one at a
    // time. Before that, this pair raced and produced the port refusals whose
    // retries left half-started servers holding their own name's lock.
    await ensureFreshDaemon('postgres', registryRoot);
    const client = postgresClient({ registryRoot });

    const [a, b] = await Promise.all([
      client.ensureDatabase('pgtest-concurrent', 'alpha', prismaDevModulePath()),
      client.ensureDatabase('pgtest-concurrent', 'beta', prismaDevModulePath()),
    ]);

    expect(a.url).not.toBe(b.url);
    for (const url of [a.url, b.url]) {
      const pg = new PgClient({ connectionString: url });
      await pg.connect();
      await pg.query('select 1');
      await pg.end();
    }

    await client.deleteApp('pgtest-concurrent');
  }, 90_000);
});
