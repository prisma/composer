/**
 * `pnPostgres()`'s runtime behavior — proven without a live database. The PN
 * client is lazy (its pool opens on first query), so hydrate is fully
 * exercisable here: `pnPostgresRuntime()` never connects just by being
 * constructed (see `fixtures/widget-contract/`'s round trip through the real
 * `prisma-next contract emit` CLI for the artifacts this suite imports).
 *
 * `pnContract<Contract>(contractJson)` pins the type parameter explicitly —
 * a JSON module import's inferred type is plain data, not the branded
 * `contract.d.ts` type, matching `@prisma-next/postgres/runtime`'s own
 * `postgres<Contract>({ contractJson })` convention (see prisma-next.ts).
 */
import { describe, expect, test } from 'bun:test';
import type { Contract, ResourceNode } from '@internal/core';
import { isNode, Load, module, string } from '@internal/core';
import { blindCast } from '@internal/foundation/casts';
import { isPnPostgresResourceNode, pnContract, pnPostgres } from '../exports/prisma-next.ts';
import { postgres } from '../postgres.ts';
import type { Contract as GadgetContract } from './fixtures/gadget-contract/emitted/contract.d.ts';
import gadgetContractJson from './fixtures/gadget-contract/emitted/contract.json' with {
  type: 'json',
};
import type { Contract as WidgetContract } from './fixtures/widget-contract/emitted/contract.d.ts';
import widgetContractJson from './fixtures/widget-contract/emitted/contract.json' with {
  type: 'json',
};

describe('pnContract().satisfies()', () => {
  test('true when the required contract has the same storageHash', () => {
    const a = pnContract<WidgetContract>(widgetContractJson);
    const b = pnContract<WidgetContract>(widgetContractJson);
    expect(a.satisfies(b)).toBe(true);
    expect(b.satisfies(a)).toBe(true);
  });

  test('false when the required contract has a different storageHash', () => {
    const widget = pnContract<WidgetContract>(widgetContractJson);
    const gadget = pnContract<GadgetContract>(gadgetContractJson);
    expect(widget.satisfies(gadget)).toBe(false);
    expect(gadget.satisfies(widget)).toBe(false);
  });

  test('false when the required contract carries a malformed __cmp (no contractJson)', () => {
    const widget = pnContract<WidgetContract>(widgetContractJson);
    // A prisma-next-kinded value whose __cmp lacks contractJson entirely —
    // storageHashOf() returns undefined, so satisfies() must be false rather
    // than throw or spuriously match.
    const malformed = {
      kind: 'prisma-next',
      __cmp: {},
      satisfies: () => false,
    } as Contract<'prisma-next', unknown>;
    expect(widget.satisfies(malformed)).toBe(false);
  });

  test("false in both directions when a wrapper's contractJson lacks storage.storageHash", () => {
    const widget = pnContract<WidgetContract>(widgetContractJson);
    // contractJson is present but shaped wrong: no `storage.storageHash`.
    // Both this wrapper's own hash and any comparison against it resolve to
    // undefined, so satisfies() is false whichever side asks.
    const hashless = pnContract<WidgetContract>({ storage: { namespaces: {} } });
    expect(widget.satisfies(hashless)).toBe(false);
    expect(hashless.satisfies(widget)).toBe(false);
    // ...and a hashless wrapper does not even satisfy itself.
    expect(hashless.satisfies(hashless)).toBe(false);
  });

  test('the wrapped contract is frozen and carries the prisma-next kind', () => {
    const widget = pnContract<WidgetContract>(widgetContractJson);
    expect(widget.kind).toBe('prisma-next');
    expect(Object.isFrozen(widget)).toBe(true);
  });
});

describe('pnPostgres() factory shapes', () => {
  test('{ name, contract, config } yields a branded resource node carrying config', () => {
    const widget = pnContract<WidgetContract>(widgetContractJson);
    const node = pnPostgres({
      name: 'database',
      contract: widget,
      config: './prisma-next.config.ts',
    });

    // The leaf class inherits the [NODE] Symbol.for brand from
    // ResourceNodeBase as an own instance field — still a recognized node.
    expect(isNode(node)).toBe(true);
    expect(node.kind).toBe('resource');
    expect(node.name).toBe('database');
    expect(node.extension).toBe('@prisma/composer-prisma-cloud');
    expect(node.type).toBe('prisma-next');
    expect(node.provides).toBe(widget);
    // config rides on the node as a first-class field, sibling to provides.
    expect(node.config).toBe('./prisma-next.config.ts');
    expect(Object.isFrozen(node)).toBe(true);
  });

  test('pnPostgres(contract) yields a branded DependencyEnd requiring that contract', () => {
    const widget = pnContract<WidgetContract>(widgetContractJson);
    const dep = pnPostgres(widget);

    expect(isNode(dep)).toBe(true);
    expect(dep.kind).toBe('dependency');
    expect(dep.type).toBe('prisma-next');
    expect(dep.required).toBe(widget);
    expect(Object.keys(dep.connection.params)).toEqual(['url']);
    expect(dep.connection.params['url']).toEqual(string());
  });
});

describe("isPnPostgresResourceNode (the deploy lowering's read predicate)", () => {
  const widget = pnContract<WidgetContract>(widgetContractJson);

  test('narrows a base-typed resource node so `.config` reads', () => {
    // The lowering's ctx.node is the base union; the predicate is a downcast
    // of a known node, not an untrusted-value guard.
    const node: ResourceNode = pnPostgres({
      name: 'database',
      contract: widget,
      config: './prisma-next.config.ts',
    });
    expect(isPnPostgresResourceNode(node)).toBe(true);
    if (isPnPostgresResourceNode(node)) {
      // the narrow gives the lowering `config` without a bare cast
      expect(node.config).toBe('./prisma-next.config.ts');
    }
  });

  test('false for a pnPostgres dependency end (kind is dependency, no config)', () => {
    // A dependency end is never a lowering's ctx.node — cast only to prove
    // the kind check rejects it.
    const dep = blindCast<ResourceNode, 'test-only: prove the kind check rejects a dependency end'>(
      pnPostgres(widget),
    );
    expect(isPnPostgresResourceNode(dep)).toBe(false);
  });

  test('false for a bare postgres() resource (type is postgres, not prisma-next)', () => {
    expect(isPnPostgresResourceNode(postgres({ name: 'db' }))).toBe(false);
  });

  test('false for a resource lookalike whose config is missing or not a string', () => {
    const noConfig = blindCast<ResourceNode, 'test-only: right kind+type, config missing'>({
      kind: 'resource',
      type: 'prisma-next',
    });
    expect(isPnPostgresResourceNode(noConfig)).toBe(false);
    const numberConfig = blindCast<ResourceNode, 'test-only: right kind+type, config not a string'>(
      { kind: 'resource', type: 'prisma-next', config: 42 },
    );
    expect(isPnPostgresResourceNode(numberConfig)).toBe(false);
  });
});

describe('the config path rides through provisioning (brand intact)', () => {
  test('a provisioned pnPostgres resource Loads as a resource and keeps config', () => {
    const widget = pnContract<WidgetContract>(widgetContractJson);
    const node = pnPostgres({
      name: 'database',
      contract: widget,
      config: './prisma-next.config.ts',
    });

    const graph = Load(
      module('pn-module', {}, ({ provision }) => {
        provision(node, { id: 'db' });
        return {};
      }),
      { id: 'pn' },
    );

    // Provisioned as a resource (the brand survived, so Load recognized it).
    const db = graph.nodes.find((n) => n.id === 'db');
    expect(db?.node.kind).toBe('resource');
    // The exact augmented node is in the graph, config and all — so the
    // predicate holds for the very value the graph carries.
    expect(db?.node).toBe(node);
    expect(isPnPostgresResourceNode(node)).toBe(true);
  });
});

describe('hydrate — the { url, client } binding (ADR-0040), no live database required', () => {
  const url = 'postgres://user:pass@localhost:5432/does-not-exist';

  test('the binding carries the wire url and is frozen', async () => {
    const widget = pnContract<WidgetContract>(widgetContractJson);
    const binding = await pnPostgres(widget).connection.hydrate({ url });

    expect(binding.url).toBe(url);
    expect(Object.isFrozen(binding)).toBe(true);
  });

  test('first client access constructs the Prisma Next client without connecting', async () => {
    const widget = pnContract<WidgetContract>(widgetContractJson);
    const binding = await pnPostgres(widget).connection.hydrate({ url });

    const client = binding.client;
    // The PostgresClient surface — constructed synchronously; nothing here
    // implies a connection was opened (pool.connect() only happens on first
    // query/`.runtime()`/`.connect()` call, none of which this test makes).
    expect(typeof client.sql).toBe('object');
    expect(typeof client.orm).toBe('object');
    expect(typeof client.connect).toBe('function');
    expect(typeof client.runtime).toBe('function');
    expect(typeof client.close).toBe('function');
  });

  test('the client is memoized — repeated accesses return the same reference', async () => {
    const widget = pnContract<WidgetContract>(widgetContractJson);
    const binding = await pnPostgres(widget).connection.hydrate({ url });

    expect(binding.client).toBe(binding.client);
  });

  test('a contract the runtime rejects fails at first client access, not at hydrate or url', async () => {
    // The runtime validates contractJson eagerly at client construction, so
    // this malformed contract is the proof of laziness: hydrate and `url`
    // succeeding means neither constructed the client — only the `client`
    // access does, and the failure surfaces there (ADR-0040).
    const malformed = pnContract<WidgetContract>({ not: 'a prisma-next contract' });
    const binding = await pnPostgres(malformed).connection.hydrate({ url });

    expect(binding.url).toBe(url);
    expect(() => binding.client).toThrow();
  });

  test('hydrate does no schema verification — it just builds the binding', () => {
    // There is no runtime marker check (ADR-0022): schema correctness is a
    // deploy-time job. Hydrate sets no `verifyMarker` and reads no database.
    const widget = pnContract<WidgetContract>(widgetContractJson);
    const dep = pnPostgres(widget);

    expect(() =>
      dep.connection.hydrate({ url: 'postgres://user:pass@localhost:5432/any-db' }),
    ).not.toThrow();
  });
});
