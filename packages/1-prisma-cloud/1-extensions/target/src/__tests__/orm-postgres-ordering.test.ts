/**
 * What a consumer of a `postgres()` database waits for, against the REAL
 * Output machinery and the real resource constructors (no cloud, nothing
 * applies). Every consumer reads the database through the lowering's `url`
 * output — its environment row writes it and its deployment's triggers carry
 * it — so whatever `url` references is what Alchemy schedules them after.
 */
import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import * as Prisma from '@alchemy.run/prisma';
import type { LowerContext, LoweredResult } from '@internal/core/deploy';
import * as Output from 'alchemy/Output';
import { Stack } from 'alchemy/Stack';
import * as Effect from 'effect/Effect';
import * as Redacted from 'effect/Redacted';
import { postgresDescriptor } from '../descriptors/orm-postgres.ts';
import { dataContract, postgres } from '../exports/orm.ts';
import widgetContractJson from './fixtures/widget-contract/emitted/contract.json' with {
  type: 'json',
};

/** A stack the resource constructors register into; nothing ever applies it. */
const stack = { name: 'shop', stage: 'prod', resources: {}, bindings: {}, actions: {} };

const registered = <A>(effect: Effect.Effect<A, unknown, unknown>): Effect.Effect<A> =>
  effect.pipe(Effect.provideService(Stack, stack as never)) as Effect.Effect<A>;

const lowering = postgresDescriptor(() => ({
  workspaceId: 'ws_1',
  providerParams: new Map(),
  preflight: { pointerVersion: () => undefined, absentSecrets: new Set() },
}));
if (lowering.kind !== 'resource') throw new Error('postgres must lower as a resource');

const ctx = {
  id: 'shop.pndata',
  address: 'shop.pndata',
  node: postgres({
    name: 'pndata',
    contract: dataContract(widgetContractJson),
    config: path.join(import.meta.dir, 'fixtures', 'widget-contract', 'source', 'prisma.config.ts'),
  }),
  graph: { root: { id: 'shop' }, edges: [], nodes: [] },
  application: {
    projectId: 'proj-1',
    branchId: undefined,
    defaultBranchId: 'br_default',
    branchless: false,
  },
} as unknown as LowerContext;

const { outputs } = await Effect.runPromise(
  registered(lowering(ctx) as Effect.Effect<LoweredResult>),
);

describe("the postgres lowering's url — what every consumer is scheduled after", () => {
  test('the url references the migration as well as the warm-up', () => {
    expect(Object.keys(Output.upstreamAny(outputs['url'])).sort()).toEqual(
      ['shop.pndata.migration', 'shop.pndata.warmup'].sort(),
    );
  });

  test('the url still resolves to the connection string, not the migration attributes', () => {
    const resolved = Effect.runSync(
      Output.evaluate(outputs['url'] as Output.Output<string>, {
        'shop.pndata.warmup': { url: 'postgres://pndata' },
        'shop.pndata.migration': { storageHash: 'sha256:target', invariants: [] },
      }) as Effect.Effect<string>,
    );
    expect(resolved).toBe('postgres://pndata');
  });

  test("a consumer's environment row built from the url waits for the migration", () => {
    const url = outputs['url'] as Output.Output<string>;
    // Built the way the compute descriptor builds a dependency-input row.
    const row = Effect.runSync(
      registered(
        Prisma.EnvironmentVariable('shop.widgets.env.COMPOSER_SHOP_WIDGETS_DB_URL', {
          project: 'proj-1',
          class: 'production',
          key: 'COMPOSER_SHOP_WIDGETS_DB_URL',
          value: Output.map(url, Redacted.make),
        }),
      ),
    );
    expect(Object.keys(Output.upstreamAny(row.Props))).toContain('shop.pndata.migration');
  });
});
