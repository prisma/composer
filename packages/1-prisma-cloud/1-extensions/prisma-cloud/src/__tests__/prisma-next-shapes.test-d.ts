/**
 * `pnPostgres()`'s two shapes, and storageHash-exact wiring compatibility.
 * `{ name, contract }` is the provisionable identity; `pnPostgres(contract)` is
 * the dependency, whose binding is the typed Prisma Next client. The
 * `WidgetContract`/`GadgetContract` types come from real `prisma-next
 * contract emit` output (`fixtures/{widget,gadget}-contract/emitted/contract.d.ts`)
 * — the branded `storageHash` literal each carries is the lever under test.
 *
 * Type-only (vitest `--typecheck`, never executed). Positive cases assert
 * the returned role and the binding via `expectTypeOf`; the wiring reject
 * case keeps a `// @ts-expect-error`.
 */
import type { BuildAdapter, DependencyEnd, Hydrated, ModuleBuilder } from '@internal/core';
import { service } from '@internal/core';
import { expectTypeOf, test } from 'vitest';
import { postgres } from '../postgres.ts';
import {
  type Client,
  type PnPostgresContract,
  type PnPostgresResourceNode,
  pnContract,
  pnPostgres,
} from '../prisma-next.ts';
import type { Contract as GadgetContract } from './fixtures/gadget-contract/emitted/contract.d.ts';
import type { Contract as WidgetContract } from './fixtures/widget-contract/emitted/contract.d.ts';

declare const widgetJson: WidgetContract;
declare const widgetJsonAgain: WidgetContract;
declare const gadgetJson: GadgetContract;

const widget = pnContract(widgetJson);
// A second, independently-wrapped value carrying the SAME emitted contract
// type — proves the lever is the type (storageHash), not object identity.
const widgetAgain = pnContract(widgetJsonAgain);
const gadget = pnContract(gadgetJson);

test('pnContract wraps an emitted contract into the prisma-next kind', () => {
  expectTypeOf(widget).toEqualTypeOf<PnPostgresContract<WidgetContract>>();
});

test('{ name, contract, config } yields the resource node carrying the config path', () => {
  const identity = pnPostgres({ name: 'db', contract: widget, config: './prisma-next.config.ts' });
  expectTypeOf(identity).toEqualTypeOf<PnPostgresResourceNode<typeof widget>>();
  // The config path rides on the node as a string field, sibling to provides.
  expectTypeOf(identity.config).toEqualTypeOf<string>();
});

test('pnPostgres(contract) yields the dependency requiring that contract; its binding is the typed client', () => {
  const dep = pnPostgres(widget);
  expectTypeOf(dep).toEqualTypeOf<DependencyEnd<Client<typeof widget>, typeof widget>>();
  // The binding load() hands the app is the Prisma Next client typed by the contract.
  expectTypeOf<Hydrated<typeof dep>>().toEqualTypeOf<Client<typeof widget>>();
});

const build: BuildAdapter = {
  extension: '@prisma/compose/node',
  type: 'node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};

const consumer = service({
  name: 'test-service',
  extension: 'test/pack',
  type: 'fake/compute',
  inputs: { db: pnPostgres(widget) },
  params: {},
  build,
});

declare const h: ModuleBuilder;

const widgetRef = h.provision(
  pnPostgres({ name: 'db', contract: widget, config: './prisma-next.config.ts' }),
  { id: 'db1' },
);
const widgetAgainRef = h.provision(
  pnPostgres({ name: 'db', contract: widgetAgain, config: './prisma-next.config.ts' }),
  { id: 'db2' },
);
const gadgetRef = h.provision(
  pnPostgres({ name: 'db', contract: gadget, config: './prisma-next.config.ts' }),
  { id: 'db3' },
);

test('a resource providing the SAME emitted contract (same storageHash) satisfies the dependency slot', () => {
  expectTypeOf(h.provision).toBeCallableWith(consumer, { id: 'c1', deps: { db: widgetRef } });
  // A different wrap of the identical emitted contract type also satisfies —
  // the lever is the type (storageHash), not which `pnContract()` call built it.
  expectTypeOf(h.provision).toBeCallableWith(consumer, { id: 'c2', deps: { db: widgetAgainRef } });
});

test('a resource providing a DIFFERENT emitted contract (different storageHash) is a type error', () => {
  // @ts-expect-error different storageHash — not assignable to the widget-requiring slot
  h.provision(consumer, { id: 'c3', deps: { db: gadgetRef } });
});

const barePostgresRef = h.provision(postgres({ name: 'db4' }), { id: 'db4' });

test('a resource of a different protocol kind entirely (bare postgresContract) is a type error', () => {
  // @ts-expect-error postgresContract's kind is "postgres", not "prisma-next"
  h.provision(consumer, { id: 'c4', deps: { db: barePostgresRef } });
});
