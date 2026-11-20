/**
 * What a consumer of a `postgres()` database waits for, against the REAL Output machinery and the real resource
 * constructors (no cloud, nothing applies): the url reaches the consumer's deployment through its `variables`.
 */
import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import type { LowerContext, LoweredResult } from '@internal/core/deploy';
import * as Output from 'alchemy/Output';
import { Stack } from 'alchemy/Stack';
import * as Effect from 'effect/Effect';
import { compute } from '../compute.ts';
import { computeDescriptor } from '../descriptors/compute.ts';
import { postgresDescriptor } from '../descriptors/orm-postgres.ts';
import { rawPostgres } from '../exports/index.ts';
import { dataContract, postgres } from '../exports/orm.ts';
import widgetContractJson from './fixtures/widget-contract/emitted/contract.json' with {
  type: 'json',
};

const build = {
  extension: '@prisma/composer/node',
  type: 'node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};

/** A stack the resource constructors register into; nothing ever applies it. */
const stack = { name: 'shop', stage: 'prod', resources: {}, bindings: {}, actions: {} };

const registered = <A>(effect: Effect.Effect<A, unknown, unknown>): Effect.Effect<A> =>
  effect.pipe(Effect.provideService(Stack, stack as never)) as Effect.Effect<A>;

const lowering = postgresDescriptor(() => ({
  workspaceId: 'ws_1',
  providerParams: new Map(),
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

  test("a consumer's deployment, created with the url in its variables, waits for the migration", async () => {
    const consumer = compute({ name: 'widgets', deps: { db: rawPostgres() }, build });
    const consumerCtx = {
      ...ctx,
      id: 'shop.widgets',
      address: 'shop.widgets',
      node: consumer,
      graph: { root: { id: 'shop' }, edges: [], nodes: [], inputBindings: [] },
      lowered: new Map(),
      provisioned: new Map(),
    } as unknown as LowerContext;
    const descriptor = computeDescriptor(() => ({
      workspaceId: 'ws_1',
      providerParams: new Map(),
    }));

    await Effect.runPromise(
      registered(
        Effect.gen(function* () {
          const provisioned = yield* descriptor.provision(consumerCtx);
          const serialized = yield* descriptor.serialize(consumerCtx, provisioned, {
            service: { port: 3000 },
            inputs: { db: { url: outputs['url'] } },
          });
          yield* descriptor.deploy(
            consumerCtx,
            provisioned,
            { path: '/tmp/widgets.tar.gz', sha256: 'sha-widgets' },
            serialized,
          );
        }) as Effect.Effect<void, unknown, unknown>,
      ),
    );

    const deployment = (stack.resources as Record<string, { Props: unknown }>)[
      'shop.widgets.deployment'
    ];
    expect(Object.keys(Output.upstreamAny(deployment?.Props))).toContain('shop.pndata.migration');
  });
});
