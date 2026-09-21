import { afterAll, beforeAll, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import type { LocalTargetProvidersInput } from '@internal/core/config';
import { ensureDaemon, postgresClient } from '@internal/dev-emulators';
import { Database } from 'alchemy/Prisma';
import * as Effect from 'effect/Effect';
import * as Redacted from 'effect/Redacted';
import { LocalDatabaseProvider, resolvePrismaDevModulePath } from '../postgres.ts';

/**
 * The Database reconcile's PUT is the only thing that restarts a database
 * server, and a restarted postgres daemon drops them all. With
 * unchanged props Alchemy's default diff is noop, so a warm `dev` never
 * re-PUT and reported ready over dead database ports. The provider must diff
 * as update even when nothing changed — declaring its attributes stable only
 * while the daemon still records the same URL, so consumers keep noop-ing.
 *
 * Runs against the machine-global daemon, like postgres-instance-name-drift.
 */

const APP = 'pgreconciletestapp';
const input: LocalTargetProvidersInput = {
  container: { input: { appName: APP, stage: undefined }, serialize: () => 'x' },
  devDir: '/dev/null/unused',
};
const props = { project: 'p', name: 'database', region: 'us-east-1' };

beforeAll(async () => {
  await ensureDaemon(
    'postgres',
    fileURLToPath(import.meta.resolve('@internal/dev-emulators/postgres-main')),
  );
});

afterAll(async () => {
  await postgresClient()
    .deleteApp(APP, resolvePrismaDevModulePath())
    .catch(() => undefined);
});

test('the local Database provider never diffs as noop, and is stable only while its URL is pinned', async () => {
  const service = await Effect.runPromise(
    Database.Provider.pipe(Effect.provide(LocalDatabaseProvider(input))),
  );
  const common = { id: 'db', fqn: 'db', instanceId: 'db', session: undefined, bindings: [] };
  const output: Database['Attributes'] = await Effect.runPromise(
    service.reconcile({ ...common, news: props, olds: undefined, output: undefined } as never),
  );
  const diff = (out: Database['Attributes']) =>
    Effect.runPromise(
      service.diff!({
        ...common,
        olds: props,
        news: props,
        oldBindings: [],
        newBindings: [],
        output: out,
      } as never),
    );

  expect(await diff(output)).toEqual({ action: 'update', stables: Object.keys(output) });
  const moved = { ...output, directConnectionString: Redacted.make('postgres://elsewhere:1/x') };
  expect(await diff(moved)).toEqual({ action: 'update' });
}, 60_000);
