/**
 * The Postgres emulator (local-dev spec § 2 `postgres-main.ts`): database
 * instances keyed by ids the emulator generates, each served by its own
 * `@prisma/dev` server; stop and start keeping data and port; delete
 * removing the data; port allocation and its retries; adoption of a server
 * another process holds; and discarding an earlier version's state. Every
 * test uses a temp `registryRoot` and deletes the instances it created, so
 * it never leaves persisted PGlite data behind.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deleteServer, getServerStatus } from '@prisma/dev/internal/state';
import getPort, { portNumbers } from 'get-port';
import { Client as PgClient } from 'pg';
import { type PostgresClient, postgresClient } from '../client.ts';
import { daemonStateDir, ensureDaemon, stopDaemon } from '../daemon.ts';
import { type RegistryScanHost, registryClaimedPorts } from '../prisma-dev-registry.ts';
import { ensureFreshDaemon, entryFor, prismaDevModulePath, tempDir, waitFor } from './helpers.ts';

let registryRoot: string;
let created: string[];

beforeEach(() => {
  registryRoot = tempDir('postgres-registry');
  created = [];
});

afterEach(async () => {
  const client = (() => {
    try {
      return postgresClient({ registryRoot });
    } catch {
      return undefined;
    }
  })();
  for (const id of created) await client?.deleteInstance(id).catch(() => undefined);
  await stopDaemon('postgres', { registryRoot }).catch(() => undefined);
});

async function startedClient(): Promise<PostgresClient> {
  await ensureFreshDaemon('postgres', registryRoot);
  return postgresClient({ registryRoot });
}

async function createDatabase(
  client: PostgresClient,
  opts: { readonly labels?: Record<string, string>; readonly port?: number } = {},
) {
  const instance = await client.createInstance({
    labels: opts.labels ?? {},
    ...(opts.port !== undefined ? { port: opts.port } : {}),
    prismaDevModulePath: prismaDevModulePath(),
  });
  created.push(instance.id);
  return instance;
}

/**
 * `@prisma/dev`'s entry reached through a symlink under `under` — a module
 * path that lives inside a directory the test chooses, and that disappears
 * when that directory is removed, as an upgraded install's old copy does.
 */
function linkedPrismaDevModulePath(under: string): string {
  const entry = fs.realpathSync(prismaDevModulePath());
  let packageDir = path.dirname(entry);
  while (!fs.existsSync(path.join(packageDir, 'package.json')))
    packageDir = path.dirname(packageDir);
  const linkParent = path.join(under, 'node_modules', '@prisma');
  fs.mkdirSync(linkParent, { recursive: true });
  fs.symlinkSync(packageDir, path.join(linkParent, 'dev'));
  return path.join(linkParent, 'dev', path.relative(packageDir, entry));
}

async function query(url: string, sql: string, params: unknown[] = []): Promise<unknown[]> {
  const pg = new PgClient({ connectionString: url });
  await pg.connect();
  try {
    return (await pg.query(sql, params)).rows;
  } finally {
    await pg.end().catch(() => undefined);
  }
}

function acceptsConnection(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

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

describe('database instances', () => {
  test('create, list, get and delete a database; the server is a real Postgres', async () => {
    const client = await startedClient();
    const labels = { 'composer.app': 'My App', note: 'any: /value' };

    const db = await createDatabase(client, { labels });

    expect(db.id).toMatch(/^db_[0-9a-f]{16}$/);
    expect(db.labels).toEqual(labels);
    expect(db.status).toBe('running');
    expect(db.url).toMatch(/^postgres:\/\//);
    expect(Number(new URL(db.url).port)).toBe(db.port);
    expect(await query(db.url, 'select 1 as one')).toEqual([{ one: 1 }]);
    expect((await client.listInstances()).map((i) => i.id)).toEqual([db.id]);
    expect(await client.getInstance(db.id)).toEqual(db);

    await client.deleteInstance(db.id);

    expect(await client.getInstance(db.id)).toBeUndefined();
    expect(await acceptsConnection(db.port)).toBe(false);
    // 60s: this boots a real Postgres, and a loaded CI runner is slow.
  }, 60_000);

  test('two instances with the same labels are separate databases', async () => {
    const client = await startedClient();
    const labels = { 'composer.app': 'same-app', 'composer.address': 'db' };
    const a = await createDatabase(client, { labels });
    const b = await createDatabase(client, { labels });

    await query(a.url, 'create table marker (v text)');

    expect(a.port).not.toBe(b.port);
    expect(await query(b.url, "select to_regclass('marker') as reg")).toEqual([{ reg: null }]);
  }, 60_000);

  test('a start naming an unknown instance fails and names it; a stop skips it', async () => {
    const client = await startedClient();
    const db = await createDatabase(client);

    await expect(
      client.startInstances([db.id, 'db_0000000000000000'], prismaDevModulePath()),
    ).rejects.toThrow('"db_0000000000000000"');
    await client.stopInstances([db.id, 'db_0000000000000000']);

    expect((await client.getInstance(db.id))?.status).toBe('stopped');
  }, 60_000);
});

describe('stop and start', () => {
  test('a stopped database holds its port and no server; a start brings it back with its data', async () => {
    const client = await startedClient();
    const db = await createDatabase(client);
    await query(db.url, 'create table kept (v text)');
    await query(db.url, "insert into kept values ('row')");

    await client.stopInstances([db.id]);

    expect(await client.getInstance(db.id)).toMatchObject({ status: 'stopped', port: db.port });
    expect(await acceptsConnection(db.port)).toBe(false);
    const other = await createDatabase(client, { port: db.port });
    expect(other.port).not.toBe(db.port);

    await client.startInstances([db.id], prismaDevModulePath());

    const restarted = await client.getInstance(db.id);
    expect(restarted).toMatchObject({ status: 'running', port: db.port, url: db.url });
    expect(await query(db.url, 'select v from kept')).toEqual([{ v: 'row' }]);
  }, 90_000);

  test('starting a running database changes nothing', async () => {
    const client = await startedClient();
    const db = await createDatabase(client);
    await query(db.url, 'create table still_here (v text)');

    await client.startInstances([db.id], prismaDevModulePath());

    expect(await client.getInstance(db.id)).toMatchObject({ status: 'running', url: db.url });
    expect(await query(db.url, "select to_regclass('still_here') is not null as ok")).toEqual([
      { ok: true },
    ]);
  }, 60_000);

  test('after an emulator restart a database is stopped, and a start brings it back on its port with its data', async () => {
    const client = await startedClient();
    const db = await createDatabase(client);
    await query(db.url, 'create table restart_check (id integer primary key)');
    await query(db.url, 'insert into restart_check (id) values (1)');

    await stopDaemon('postgres', { registryRoot });
    await ensureDaemon('postgres', entryFor('postgres'), { registryRoot });
    const after = postgresClient({ registryRoot });

    expect(await after.getInstance(db.id)).toMatchObject({ status: 'stopped', port: db.port });
    await after.startInstances([db.id], prismaDevModulePath());
    expect(await after.getInstance(db.id)).toMatchObject({ status: 'running', url: db.url });
    expect(await query(db.url, 'select id from restart_check')).toEqual([{ id: 1 }]);
  }, 90_000);

  test('deleting a stopped database removes its data', async () => {
    const client = await startedClient();
    const db = await createDatabase(client);
    await client.stopInstances([db.id]);

    await client.deleteInstance(db.id);

    expect(await client.getInstance(db.id)).toBeUndefined();
    expect(await getServerStatus(`pcdev-${db.id}`)).toMatchObject({ status: 'no_such_server' });
  }, 60_000);
});

describe('deleting with the caller’s @prisma/dev', () => {
  test('deletes the data even when the module the database was created with is gone', async () => {
    const client = await startedClient();
    const oldInstall = tempDir('removed-install');
    const db = await client.createInstance({
      labels: {},
      prismaDevModulePath: linkedPrismaDevModulePath(oldInstall),
    });
    created.push(db.id);
    fs.rmSync(oldInstall, { recursive: true, force: true });

    await client.deleteInstance(db.id, prismaDevModulePath());

    expect(await client.getInstance(db.id)).toBeUndefined();
    expect(await getServerStatus(`pcdev-${db.id}`)).toMatchObject({ status: 'no_such_server' });
  }, 60_000);
});

describe('Postgres messages larger than one loopback TCP read', () => {
  // A regression test for @prisma/dev 0.20.0, whose pglite-socket 0.0.20
  // handed each raw 64 KiB TCP chunk to PGlite as if it were a whole
  // message: a bind parameter over that size killed the engine and every
  // later connection was refused. Composer now pins a fixed @prisma/dev;
  // this test fails against the old one.
  test('a 100 KiB bind parameter round-trips and the server keeps accepting connections', async () => {
    const client = await startedClient();
    const { url } = await createDatabase(client);

    const payload = 'x'.repeat(100 * 1024);
    expect(await query(url, 'select length($1::text) as len', [payload])).toEqual([
      { len: payload.length },
    ]);
    expect(await query(url, 'select 1 as one')).toEqual([{ one: 1 }]);
  }, 60_000);
});

describe('ports', () => {
  test('a requested port that is free is given', async () => {
    const client = await startedClient();
    const requested = await getPort({ port: portNumbers(58_000, 59_000) });

    const db = await createDatabase(client, { port: requested });

    expect(db.port).toBe(requested);
  }, 60_000);

  test("a deleted database's port can be requested again at once", async () => {
    const client = await startedClient();
    const db = await createDatabase(client);
    await client.deleteInstance(db.id);

    const again = await createDatabase(client, { port: db.port });

    expect(again.port).toBe(db.port);
  }, 60_000);

  test('databases created at once by emulators in two emulators directories each start again on their own port', async () => {
    const client = await startedClient();
    const otherRoot = tempDir('postgres-other-registry');
    await ensureFreshDaemon('postgres', otherRoot);
    const other = postgresClient({ registryRoot: otherRoot });
    const otherCreated: string[] = [];
    try {
      const create = async (target: PostgresClient, ids: string[]) => {
        const db = await target.createInstance({
          labels: {},
          prismaDevModulePath: prismaDevModulePath(),
        });
        ids.push(db.id);
        return db;
      };
      const databases = await Promise.all([
        create(client, created),
        create(client, created),
        create(other, otherCreated),
        create(other, otherCreated),
      ]);
      await client.stopInstances(created);
      await other.stopInstances(otherCreated);
      await client.startInstances(created, prismaDevModulePath());
      await other.startInstances(otherCreated, prismaDevModulePath());

      expect(new Set(databases.map((db) => db.port)).size).toBe(databases.length);
      for (const db of databases)
        expect(await query(db.url, 'select 1 as one')).toEqual([{ one: 1 }]);
    } finally {
      for (const id of otherCreated) await other.deleteInstance(id).catch(() => undefined);
      await stopDaemon('postgres', { registryRoot: otherRoot }).catch(() => undefined);
    }
  }, 120_000);

  test('a bind failure on a fresh allocation moves to the next free port', async () => {
    const client = await startedClient();
    // Occupy the FIRST candidate database port a fresh allocation would
    // pick, forcing the retry path.
    const squatter = await occupyPort(51_300);
    try {
      const db = await createDatabase(client);
      expect(db.port).toBeGreaterThan(51_300);
      expect(await query(db.url, 'select 1 as one')).toEqual([{ one: 1 }]);
    } finally {
      await closeServer(squatter);
    }
  }, 60_000);
});

describe('a bogus prismaDevModulePath', () => {
  test('surfaces 500 naming the resolution failure without leaking unrelated paths, and creates nothing', async () => {
    const client = await startedClient();
    const bogusPath = '/definitely/not/a/real/path/to/prisma-dev/index.js';

    const message = await client
      .createInstance({ labels: {}, prismaDevModulePath: bogusPath })
      .then(
        () => 'created',
        (err: unknown) => (err instanceof Error ? err.message : String(err)),
      );

    expect(message).toContain('(500)');
    expect(message).toContain('local dev needs @prisma/dev');
    expect(message).toContain(bogusPath);
    // No OTHER filesystem path leaks — a dynamic `import()` failure's own
    // message routinely names a SECOND path (the importer's own location).
    const pathsInMessage = [...message.matchAll(/(?:\/[^\s"')/]+){2,}/g)].map((m) => m[0]);
    expect([...new Set(pathsInMessage)]).toEqual([bogusPath]);
    expect(await client.listInstances()).toEqual([]);
  }, 15_000);
});

describe("a server another process holds under an instance's name", () => {
  test('a start adopts it instead of starting a second one, and the emulator stays up', async () => {
    // A daemon replaced for version skew can leave a server live in another
    // process under an instance's name. Starting into that used to surface
    // "already running" as a 500. The foreign server runs in its OWN
    // process: its record names its host's pid, and stopping an adopted
    // server signals that pid.
    const client = await startedClient();
    const db = await createDatabase(client);
    await client.stopInstances([db.id]);
    const serverName = `pcdev-${db.id}`;

    const scriptPath = path.join(tempDir('adopt-host'), 'host.mjs');
    fs.writeFileSync(
      scriptPath,
      `import { startPrismaDevServer } from ${JSON.stringify(pathToFileURL(prismaDevModulePath()).href)};
const server = await startPrismaDevServer({ name: ${JSON.stringify(serverName)}, databasePort: ${String(db.port)}, persistenceMode: 'stateful' });
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
      await client.startInstances([db.id], prismaDevModulePath());

      expect(await client.getInstance(db.id)).toMatchObject({ status: 'running', url: foreignUrl });
      expect(await query(foreignUrl, 'select 1 as one')).toEqual([{ one: 1 }]);
      expect((await client.health()).version.length).toBeGreaterThan(0);
    } finally {
      host.kill('SIGKILL');
    }
  }, 60_000);
});

describe("a stale @prisma/dev record claiming a port in the daemon's database range", () => {
  test('a fresh allocation skips record-claimed ports instead of starting into a refusal', async () => {
    // `startPrismaDevServer` refuses a requested port that any server
    // RECORD on the machine claims, even when nothing has it bound — and
    // the refusal happens after it acquired the name's lock, which the
    // failure path never releases, poisoning the name for this daemon
    // process. A record whose ports sit inside the daemon's own database
    // range is therefore a trap for any pick that only probes the OS.
    // Seen on CI in the store test's --fresh cycle: `@prisma/dev`'s own
    // aux-port picker walks upward from 51213 and after a few servers
    // crosses 51300.
    // Unique per run: a failed earlier run on this machine may have left
    // this very name's lock behind (the phenomenon under test).
    const squatterName = `pcdev-pgtest-squatter-${String(process.pid)}`;
    const prismaDev = (await import(pathToFileURL(prismaDevModulePath()).href)) as {
      startPrismaDevServer(options: {
        name: string;
        databasePort: number;
        persistenceMode: 'stateful';
      }): Promise<{ close(): Promise<void> }>;
    };
    // The developer machine running this test may itself carry stale
    // records claiming ports in this range, and a refused start would
    // poison the squatter's own name (the very defect under test) — so the
    // pick consults the records up front, the same way the fixed daemon
    // does.
    const state = (await import('@prisma/dev/internal/state')) as unknown as RegistryScanHost;
    const claimed = [...(await registryClaimedPorts(state, squatterName))];
    const squatterPort = await getPort({ port: portNumbers(51_300, 65_535), exclude: claimed });
    const squatter = await prismaDev.startPrismaDevServer({
      name: squatterName,
      databasePort: squatterPort,
      persistenceMode: 'stateful',
    });
    // Close WITHOUT deleting: the record survives, still claiming the
    // port, while the port itself is free again — the trap is armed.
    await squatter.close();

    try {
      const client = await startedClient();

      const db = await createDatabase(client);

      expect(db.port).not.toBe(squatterPort);
      expect(await query(db.url, 'select 1 as one')).toEqual([{ one: 1 }]);
    } finally {
      await deleteServer(squatterName).catch(() => undefined);
    }
  }, 120_000);
});

describe('a create whose start refused a port after taking the name lock', () => {
  test('fails, records nothing, and the emulator keeps creating databases', async () => {
    // A start can refuse a port after `@prisma/dev` took the name's lock,
    // which leaks the lock. This forces one: a stand-in @prisma/dev module
    // whose start requests a port another record claims. A failed create
    // records no instance, so its leaked name is never used again.
    const realIndexUrl = pathToFileURL(prismaDevModulePath()).href;
    const realStateUrl = pathToFileURL(
      fileURLToPath(import.meta.resolve('@prisma/dev/internal/state')),
    ).href;

    const fixtureDir = tempDir('leaky-prisma-dev');
    fs.writeFileSync(
      path.join(fixtureDir, 'package.json'),
      JSON.stringify({
        name: '@prisma/dev',
        type: 'module',
        exports: { '.': './index.mjs', './internal/state': './state.mjs' },
      }),
    );
    fs.writeFileSync(
      path.join(fixtureDir, 'state.mjs'),
      `export * from ${JSON.stringify(realStateUrl)};\n`,
    );
    fs.writeFileSync(
      path.join(fixtureDir, 'index.mjs'),
      `import { startPrismaDevServer as realStart } from ${JSON.stringify(realIndexUrl)};
import { ServerState } from ${JSON.stringify(realStateUrl)};
export async function startPrismaDevServer(options) {
  const records = await ServerState.scan({ onlyMetadata: true });
  const clash = records.find(
    (r) => r.name !== options.name && typeof r.shadowDatabasePort === 'number' && r.shadowDatabasePort > 0,
  );
  if (!clash) throw new Error('fixture: no record to clash with');
  const server = await realStart({ ...options, databasePort: clash.shadowDatabasePort });
  await server.close();
  throw new Error('fixture: expected the real start to refuse the claimed port');
}
`,
    );

    const client = await startedClient();

    // A real database first, so a record exists for the fixture to clash with.
    const anchor = await createDatabase(client);

    await expect(
      client.createInstance({
        labels: {},
        prismaDevModulePath: path.join(fixtureDir, 'index.mjs'),
      }),
    ).rejects.toThrow(/belongs to another Prisma Dev server/);

    expect((await client.listInstances()).map((i) => i.id)).toEqual([anchor.id]);
    const next = await createDatabase(client);
    expect(await query(next.url, 'select 1 as one')).toEqual([{ one: 1 }]);
  }, 120_000);
});

describe('concurrent creates', () => {
  test('two databases created at once both come up — starts are serialized', async () => {
    // An app converges its databases in parallel, so the daemon receives
    // simultaneous ensures for different names. `@prisma/dev`'s start is not
    // concurrency-safe within a process — two at once pick ports without
    // seeing each other and one fails — so the daemon runs starts one at a
    // time. Before that, this pair raced and produced the port refusals whose
    // retries left half-started servers holding their own name's lock.
    const client = await startedClient();

    const [a, b] = await Promise.all([createDatabase(client), createDatabase(client)]);

    expect(a.url).not.toBe(b.url);
    for (const { url } of [a, b]) expect(await query(url, 'select 1 as one')).toEqual([{ one: 1 }]);
  }, 90_000);
});

describe('state written by an earlier version', () => {
  function writeEarlierState(serverName: string): string {
    const stateDir = daemonStateDir(registryRoot, 'postgres');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'apps.json'),
      JSON.stringify({
        'legacy-app': {
          databases: {
            db: { id: 'db', instanceName: serverName, databasePort: 51_300, url: 'postgres://x' },
          },
        },
      }),
    );
    return stateDir;
  }

  test("is removed on load, and its servers' data is deleted on the next create", async () => {
    const legacyName = `pcdev-pgtest-legacy-${String(process.pid)}`;
    const prismaDev = (await import(pathToFileURL(prismaDevModulePath()).href)) as {
      startPrismaDevServer(options: {
        name: string;
        persistenceMode: 'stateful';
      }): Promise<{ close(): Promise<void> }>;
    };
    const legacy = await prismaDev.startPrismaDevServer({
      name: legacyName,
      persistenceMode: 'stateful',
    });
    await legacy.close();
    const stateDir = writeEarlierState(legacyName);

    try {
      const client = await startedClient();
      expect(fs.existsSync(path.join(stateDir, 'apps.json'))).toBe(false);
      expect(await client.listInstances()).toEqual([]);

      await createDatabase(client);

      expect(await getServerStatus(legacyName)).toMatchObject({ status: 'no_such_server' });
    } finally {
      await deleteServer(legacyName).catch(() => undefined);
    }
  }, 60_000);

  test('a server another live process still serves is left alone until that process ends', async () => {
    // Under the old names, another emulators directory's daemon could be
    // serving a server this state names. Its data must survive, and its
    // process must not be signalled: that would end every server it hosts.
    const legacyName = `pcdev-pgtest-legacy-live-${String(process.pid)}`;
    const scriptPath = path.join(tempDir('legacy-host'), 'host.mjs');
    fs.writeFileSync(
      scriptPath,
      `import { startPrismaDevServer } from ${JSON.stringify(pathToFileURL(prismaDevModulePath()).href)};
const server = await startPrismaDevServer({ name: ${JSON.stringify(legacyName)}, persistenceMode: 'stateful' });
console.log(server.database.connectionString);
setInterval(() => {}, 1 << 30);
`,
    );
    const host = spawn(process.execPath, [scriptPath], { stdio: ['ignore', 'pipe', 'inherit'] });
    const hostUrl = await new Promise<string>((resolve, reject) => {
      let out = '';
      host.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString();
        const line = out.split('\n')[0];
        if (line !== undefined && out.includes('\n')) resolve(line.trim());
      });
      host.once('error', reject);
      host.once('exit', (code) => reject(new Error(`host exited early (${String(code)})`)));
    });
    await query(hostUrl, "create table kept (v text); insert into kept values ('live')");
    const stateDir = writeEarlierState(legacyName);

    try {
      const client = await startedClient();
      await createDatabase(client);

      expect(await getServerStatus(legacyName)).toMatchObject({ status: 'running' });
      expect(await query(hostUrl, 'select v from kept')).toEqual([{ v: 'live' }]);
      const state: unknown = JSON.parse(
        fs.readFileSync(path.join(stateDir, 'instances.json'), 'utf8'),
      );
      expect(state).toMatchObject({ discardedServers: [legacyName] });

      const exited = new Promise((resolve) => host.once('exit', resolve));
      host.kill('SIGKILL');
      await exited;
      await createDatabase(client);

      expect(await getServerStatus(legacyName)).toMatchObject({ status: 'no_such_server' });
    } finally {
      host.kill('SIGKILL');
      await deleteServer(legacyName).catch(() => undefined);
    }
  }, 90_000);
});

/**
 * The emulator never interprets Composer's data: an app name, a node address
 * or a directory reaches it only as label values, and the `@prisma/dev`
 * module path (under the project's `node_modules`) is stored verbatim.
 */
describe('the emulator never interprets Composer data', () => {
  test('labels and the module path are stored verbatim, and nothing else carries their values', async () => {
    // The module path lies under the project in real use, so it carries the
    // directory; it reaches the state only through its own field.
    const client = await startedClient();
    const directory = path.join(tempDir('marker-project'), 'zzdirectorymarker');
    const modulePath = linkedPrismaDevModulePath(directory);
    const labels = {
      'composer.directory': directory,
      'composer.app': 'zzappmarker',
      'composer.address': 'zzaddressmarker',
    };
    const db = await client.createInstance({ labels, prismaDevModulePath: modulePath });
    created.push(db.id);

    const stateDir = daemonStateDir(registryRoot, 'postgres');
    const statePath = path.join(stateDir, 'instances.json');
    await waitFor(
      () => fs.existsSync(statePath) && fs.readFileSync(statePath, 'utf8').includes(db.id),
      5000,
    );
    const state: unknown = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const record: unknown = Reflect.get(Reflect.get(state as object, 'instances'), db.id);
    expect(record).toMatchObject({ labels, prismaDevModulePath: modulePath });

    const opaque = (key: string, value: unknown) =>
      key === 'labels' || key === 'prismaDevModulePath' ? undefined : value;
    const withoutLabels = JSON.stringify(state, opaque);
    const listed = JSON.stringify(await client.listInstances(), opaque);
    for (const marker of ['zzdirectorymarker', 'zzappmarker', 'zzaddressmarker']) {
      expect(withoutLabels).not.toContain(marker);
      expect(listed).not.toContain(marker);
      for (const file of fs.readdirSync(stateDir, { recursive: true })) {
        expect(String(file)).not.toContain(marker);
      }
    }
  }, 60_000);

  test("the emulator's code names no app, address, directory or Composer concept", () => {
    const source = fs.readFileSync(
      fileURLToPath(new URL('../postgres-main.ts', import.meta.url)),
      'utf8',
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    expect(code).not.toMatch(/\b(apps?|appName|address(es)?|directory|composer)\b/i);
  });
});
