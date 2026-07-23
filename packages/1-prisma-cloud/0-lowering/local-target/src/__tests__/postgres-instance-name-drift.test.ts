import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import type { ContainerInstance, LocalTargetProvidersInput } from '@internal/core/config';
import { ensureDaemon, instanceNameFor, postgresClient } from '@internal/dev-emulators';
import { Connection, Database } from '@internal/lowering/postgres';
import * as Effect from 'effect/Effect';
import * as Redacted from 'effect/Redacted';
import { LocalConnectionProvider, LocalDatabaseProvider } from '../postgres.ts';

/**
 * Delta review finding A (#160): `LocalDatabaseProvider` used to re-derive
 * the instance name with its OWN slug, which dropped the daemon's
 * leading/trailing-dash trim — a database id or app name ending in a
 * hyphen (the wire protocol's own segment rule already forbids a LEADING
 * non-alphanumeric, so a trailing hyphen is the pathological shape that
 * actually reaches these providers) produced a DIFFERENT concatenated name
 * here than the one the daemon actually created the server under (a
 * doubled dash at the boundary), so `LocalConnectionProvider`'s
 * listing-based lookup threw `noRecordedInstanceError` even though the
 * server existed. Both providers now import `instanceNameFor` directly
 * from `@internal/dev-emulators` — one implementation, so this can no
 * longer drift. This test proves it end to end, against the real daemon,
 * for exactly the pathological shape that used to fail: an app name AND a
 * database id each ending in a hyphen.
 */

const APP = 'pgdrifttestapp-';
const DATABASE_ID = 'orders-';

function fakeContainer(appName: string): ContainerInstance {
  return { input: { appName, stage: undefined }, serialize: () => 'x' };
}

// The default, machine-global daemon (the SAME one `postgresClient()` inside
// the providers under test talks to) — this test's whole point is proving
// the providers agree with the REAL daemon, so it must run against the one
// registry those providers actually resolve, not an isolated test seam.
// `ensureDaemon` adopts an already-healthy daemon, so this is cheap and
// idempotent alongside every other suite that also ensures it.
beforeAll(async () => {
  const entry = fileURLToPath(import.meta.resolve('@internal/dev-emulators/postgres-main'));
  await ensureDaemon('postgres', entry);
});

afterAll(async () => {
  await postgresClient()
    .deleteApp(APP)
    .catch(() => undefined);
});

describe('instance-name drift (delta review finding A, #160)', () => {
  test('a database id and app name with leading/trailing non-alphanumerics: Database ensures, Connection resolves the SAME server', async () => {
    const input: LocalTargetProvidersInput = {
      container: fakeContainer(APP),
      devDir: '/dev/null/unused',
    };

    // 1. Ensure through the real daemon (LocalDatabaseProvider's own reconcile).
    const databaseService = await Effect.runPromise(
      Database.Provider.pipe(Effect.provide(LocalDatabaseProvider(input))),
    );
    const databaseAttributes = await Effect.runPromise(
      databaseService.reconcile({
        id: 'db',
        instanceId: 'db',
        news: { projectId: 'p', name: DATABASE_ID, region: 'us-east-1' },
        olds: undefined,
        output: undefined,
        session: undefined as never,
        bindings: [],
      }),
    );

    // The provider-derived id is exactly the daemon's own derivation — no
    // second implementation to drift from it.
    expect(databaseAttributes.id).toBe(instanceNameFor(APP, DATABASE_ID));
    expect(databaseAttributes.id).toBe('pcdev-pgdrifttestapp-orders');
    // Proves the trim/collapse actually happened — the pre-fix drift left a
    // doubled dash at the "pgdrifttestapp-" + "-" + "orders-" boundary.
    expect(databaseAttributes.id.includes('--')).toBe(false);

    // 2. Connection-resolve through the listing (LocalConnectionProvider's
    // own reconcile) — before the fix, this threw noRecordedInstanceError
    // for this exact pathological pair.
    const connectionService = await Effect.runPromise(
      Connection.Provider.pipe(Effect.provide(LocalConnectionProvider(input))),
    );
    const connectionAttributes = await Effect.runPromise(
      connectionService.reconcile({
        id: 'conn',
        instanceId: 'conn',
        news: { databaseId: databaseAttributes.id, name: 'conn' },
        olds: undefined,
        output: undefined,
        session: undefined as never,
        bindings: [],
      }),
    );

    expect(connectionAttributes.id).toBe(databaseAttributes.id);
    expect(Redacted.value(connectionAttributes.connectionString)).toMatch(/^postgres:\/\//);

    // 3. The daemon's own listing agrees on the same name too — the third
    // independent read of the same value.
    const listed = await postgresClient().listDatabases(APP);
    const entry = listed.find((d) => d.instanceName === databaseAttributes.id);
    expect(entry).toBeDefined();
  }, 30_000);
});
