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
import type {
  BuildAdapter,
  DependencyEnd,
  Hydrated,
  ResourceNode,
  SystemBuilder,
} from '@prisma/app';
import { service } from '@prisma/app';
import { expectTypeOf, test } from 'vitest';
import { postgres } from '../postgres.ts';
import { type Client, type PnPostgresContract, pnContract, pnPostgres } from '../prisma-next.ts';
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

test('{ name, contract } yields the resource identity providing contract', () => {
  const identity = pnPostgres({ name: 'db', contract: widget });
  expectTypeOf(identity).toEqualTypeOf<ResourceNode<typeof widget>>();
});

test('pnPostgres(contract) yields the dependency requiring that contract; its binding is the typed client', () => {
  const dep = pnPostgres(widget);
  expectTypeOf(dep).toEqualTypeOf<DependencyEnd<Client<typeof widget>, typeof widget>>();
  // The binding load() hands the app is the Prisma Next client typed by the contract.
  expectTypeOf<Hydrated<typeof dep>>().toEqualTypeOf<Client<typeof widget>>();
});

const build: BuildAdapter = {
  extension: '@prisma/app-node',
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

declare const h: SystemBuilder;

const widgetRef = h.provision('db1', pnPostgres({ name: 'db', contract: widget }));
const widgetAgainRef = h.provision('db2', pnPostgres({ name: 'db', contract: widgetAgain }));
const gadgetRef = h.provision('db3', pnPostgres({ name: 'db', contract: gadget }));

test('a resource providing the SAME emitted contract (same storageHash) satisfies the dependency slot', () => {
  expectTypeOf(h.provision).toBeCallableWith('c1', consumer, { db: widgetRef });
  // A different wrap of the identical emitted contract type also satisfies —
  // the lever is the type (storageHash), not which `pnContract()` call built it.
  expectTypeOf(h.provision).toBeCallableWith('c2', consumer, { db: widgetAgainRef });
});

test('a resource providing a DIFFERENT emitted contract (different storageHash) is a type error', () => {
  // @ts-expect-error different storageHash — not assignable to the widget-requiring slot
  h.provision('c3', consumer, { db: gadgetRef });
});

const barePostgresRef = h.provision('db4', postgres({ name: 'db4' }));

test('a resource of a different protocol kind entirely (bare postgresContract) is a type error', () => {
  // @ts-expect-error postgresContract's kind is "postgres", not "prisma-next"
  h.provision('c4', consumer, { db: barePostgresRef });
});
