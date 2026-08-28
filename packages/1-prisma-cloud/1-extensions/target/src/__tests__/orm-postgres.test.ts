/**
 * `postgres()`'s runtime behavior — proven without a live database. The PN
 * client is lazy (its pool opens on first query), so hydrate is fully
 * exercisable here: `ormPostgresRuntime()` never connects just by being
 * constructed (see `fixtures/widget-contract/`'s round trip through the real
 * `prisma contract emit` CLI for the artifacts this suite imports).
 *
 * `dataContract<Contract>(contractJson)` pins the type parameter explicitly —
 * a JSON module import's inferred type is plain data, not the branded
 * `contract.d.ts` type, matching `@prisma/orm-postgres/runtime`'s own
 * `postgres<Contract>({ contractJson })` convention (see orm-postgres.ts).
 */
import { describe, expect, test } from 'bun:test';
import type { Contract, ResourceNode } from '@internal/core';
import { isNode, Load, module, string } from '@internal/core';
import { blindCast } from '@internal/foundation/casts';
import {
  dataContract,
  isPostgresResourceNode,
  postgres,
  requiredPackHead,
  requiredPackHeadOf,
} from '../exports/orm.ts';
import { rawPostgres } from '../raw-postgres.ts';
import type { Contract as GadgetContract } from './fixtures/gadget-contract/emitted/contract.d.ts';
import gadgetContractJson from './fixtures/gadget-contract/emitted/contract.json' with {
  type: 'json',
};
import type { Contract as WidgetContract } from './fixtures/widget-contract/emitted/contract.d.ts';
import widgetContractJson from './fixtures/widget-contract/emitted/contract.json' with {
  type: 'json',
};

describe('dataContract().satisfies()', () => {
  test('true when the required contract has the same storageHash', () => {
    const a = dataContract<WidgetContract>(widgetContractJson);
    const b = dataContract<WidgetContract>(widgetContractJson);
    expect(a.satisfies(b)).toBe(true);
    expect(b.satisfies(a)).toBe(true);
  });

  test('false when the required contract has a different storageHash', () => {
    const widget = dataContract<WidgetContract>(widgetContractJson);
    const gadget = dataContract<GadgetContract>(gadgetContractJson);
    expect(widget.satisfies(gadget)).toBe(false);
    expect(gadget.satisfies(widget)).toBe(false);
  });

  test('false when the required contract carries a malformed __cmp (no contractJson)', () => {
    const widget = dataContract<WidgetContract>(widgetContractJson);
    // An orm-postgres-kinded value whose __cmp lacks contractJson entirely —
    // storageHashOf() returns undefined, so satisfies() must be false rather
    // than throw or spuriously match.
    const malformed = {
      kind: 'postgres',
      __cmp: {},
      satisfies: () => false,
    } as Contract<'postgres', unknown>;
    expect(widget.satisfies(malformed)).toBe(false);
  });

  test("false in both directions when a wrapper's contractJson lacks storage.storageHash", () => {
    const widget = dataContract<WidgetContract>(widgetContractJson);
    // contractJson is present but shaped wrong: no `storage.storageHash`.
    // Both this wrapper's own hash and any comparison against it resolve to
    // undefined, so satisfies() is false whichever side asks.
    const hashless = dataContract<WidgetContract>({ storage: { namespaces: {} } });
    expect(widget.satisfies(hashless)).toBe(false);
    expect(hashless.satisfies(widget)).toBe(false);
    // ...and a hashless wrapper does not even satisfy itself.
    expect(hashless.satisfies(hashless)).toBe(false);
  });

  test('the wrapped contract is frozen and carries the orm-postgres kind', () => {
    const widget = dataContract<WidgetContract>(widgetContractJson);
    expect(widget.kind).toBe('postgres');
    expect(Object.isFrozen(widget)).toBe(true);
  });
});

describe('requiredPackHead() — the pack-head claim (wireability only)', () => {
  const requirement = requiredPackHead({ packId: 'auth', headHash: 'auth-head' });

  test('is a frozen orm-postgres-kind contract carrying the requirement in __cmp', () => {
    expect(requirement.kind).toBe('postgres');
    expect(Object.isFrozen(requirement)).toBe(true);
    expect(requiredPackHeadOf(requirement)).toEqual({
      packId: 'auth',
      headHash: 'auth-head',
    });
  });

  test('ANY dataContract() satisfies a pack requirement — before hash comparison', () => {
    // The widget contract's hash has nothing to do with the pack's head hash:
    // wireability deliberately says yes (the contract value cannot see the
    // resource's config); the deploy preflight is the enforcement point.
    const widget = dataContract<WidgetContract>(widgetContractJson);
    const gadget = dataContract<GadgetContract>(gadgetContractJson);
    expect(widget.satisfies(requirement)).toBe(true);
    expect(gadget.satisfies(requirement)).toBe(true);
  });

  test('the pack branch does not loosen hash comparison for non-requirement contracts', () => {
    const widget = dataContract<WidgetContract>(widgetContractJson);
    const gadget = dataContract<GadgetContract>(gadgetContractJson);
    expect(widget.satisfies(gadget)).toBe(false);
  });

  test('requiredPackHeadOf reads defensively — malformed shapes yield undefined', () => {
    expect(requiredPackHeadOf(undefined)).toBeUndefined();
    const widget = dataContract<WidgetContract>(widgetContractJson);
    expect(requiredPackHeadOf(widget)).toBeUndefined();
    const malformed = (cmp: unknown) =>
      ({ kind: 'postgres', __cmp: cmp, satisfies: () => false }) as Contract<'postgres', unknown>;
    expect(requiredPackHeadOf(malformed(null))).toBeUndefined();
    expect(requiredPackHeadOf(malformed({ requiredPackHead: null }))).toBeUndefined();
    expect(requiredPackHeadOf(malformed({ requiredPackHead: { packId: 'auth' } }))).toBeUndefined();
    expect(
      requiredPackHeadOf(malformed({ requiredPackHead: { packId: 42, headHash: 'x' } })),
    ).toBeUndefined();
  });
});

describe('postgres() factory shapes', () => {
  test('{ name, contract, config } yields a branded resource node carrying config', () => {
    const widget = dataContract<WidgetContract>(widgetContractJson);
    const node = postgres({
      name: 'database',
      contract: widget,
      config: './prisma.config.ts',
    });

    // The leaf class inherits the [NODE] Symbol.for brand from
    // ResourceNodeBase as an own instance field — still a recognized node.
    expect(isNode(node)).toBe(true);
    expect(node.kind).toBe('resource');
    expect(node.name).toBe('database');
    expect(node.extension).toBe('@prisma/composer-prisma-cloud');
    expect(node.type).toBe('postgres');
    expect(node.provides).toBe(widget);
    // config rides on the node as a first-class field, sibling to provides.
    expect(node.config).toBe('./prisma.config.ts');
    expect(Object.isFrozen(node)).toBe(true);
  });

  test('postgres(contract) yields a branded DependencyEnd requiring that contract', () => {
    const widget = dataContract<WidgetContract>(widgetContractJson);
    const dep = postgres(widget);

    expect(isNode(dep)).toBe(true);
    expect(dep.kind).toBe('dependency');
    expect(dep.type).toBe('postgres');
    expect(dep.required).toBe(widget);
    expect(Object.keys(dep.connection.params)).toEqual(['url']);
    expect(dep.connection.params['url']).toEqual(string());
  });
});

describe("isPostgresResourceNode (the deploy lowering's read predicate)", () => {
  const widget = dataContract<WidgetContract>(widgetContractJson);

  test('narrows a base-typed resource node so `.config` reads', () => {
    // The lowering's ctx.node is the base union; the predicate is a downcast
    // of a known node, not an untrusted-value guard.
    const node: ResourceNode = postgres({
      name: 'database',
      contract: widget,
      config: './prisma.config.ts',
    });
    expect(isPostgresResourceNode(node)).toBe(true);
    if (isPostgresResourceNode(node)) {
      // the narrow gives the lowering `config` without a bare cast
      expect(node.config).toBe('./prisma.config.ts');
    }
  });

  test('false for a postgres dependency end (kind is dependency, no config)', () => {
    // A dependency end is never a lowering's ctx.node — cast only to prove
    // the kind check rejects it.
    const dep = blindCast<ResourceNode, 'test-only: prove the kind check rejects a dependency end'>(
      postgres(widget),
    );
    expect(isPostgresResourceNode(dep)).toBe(false);
  });

  test('false for a bare postgres() resource (type is postgres, not orm-postgres)', () => {
    expect(isPostgresResourceNode(rawPostgres({ name: 'db' }))).toBe(false);
  });

  test('false for a resource lookalike whose config is missing or not a string', () => {
    const noConfig = blindCast<ResourceNode, 'test-only: right kind+type, config missing'>({
      kind: 'resource',
      type: 'postgres',
    });
    expect(isPostgresResourceNode(noConfig)).toBe(false);
    const numberConfig = blindCast<ResourceNode, 'test-only: right kind+type, config not a string'>(
      { kind: 'resource', type: 'postgres', config: 42 },
    );
    expect(isPostgresResourceNode(numberConfig)).toBe(false);
  });
});

describe('the config path rides through provisioning (brand intact)', () => {
  test('a provisioned postgres resource Loads as a resource and keeps config', () => {
    const widget = dataContract<WidgetContract>(widgetContractJson);
    const node = postgres({
      name: 'database',
      contract: widget,
      config: './prisma.config.ts',
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
    expect(isPostgresResourceNode(node)).toBe(true);
  });
});

describe('hydrate — the { url, client } binding (ADR-0040), no live database required', () => {
  const url = 'postgres://user:pass@localhost:5432/does-not-exist';

  test('the binding carries the wire url and is frozen', async () => {
    const widget = dataContract<WidgetContract>(widgetContractJson);
    const binding = await postgres(widget).connection.hydrate({ url });

    expect(binding.url).toBe(url);
    expect(Object.isFrozen(binding)).toBe(true);
  });

  test('first client access constructs the Prisma ORM client without connecting', async () => {
    const widget = dataContract<WidgetContract>(widgetContractJson);
    const binding = await postgres(widget).connection.hydrate({ url });

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
    const widget = dataContract<WidgetContract>(widgetContractJson);
    const binding = await postgres(widget).connection.hydrate({ url });

    expect(binding.client).toBe(binding.client);
  });

  test('a contract the runtime rejects fails at first client access, not at hydrate or url', async () => {
    // The runtime validates contractJson eagerly at client construction, so
    // this malformed contract is the proof of laziness: hydrate and `url`
    // succeeding means neither constructed the client — only the `client`
    // access does, and the failure surfaces there (ADR-0040).
    const malformed = dataContract<WidgetContract>({ not: 'an orm-postgres contract' });
    const binding = await postgres(malformed).connection.hydrate({ url });

    expect(binding.url).toBe(url);
    expect(() => binding.client).toThrow();
  });

  test('hydrate does no schema verification — it just builds the binding', () => {
    // There is no runtime marker check (ADR-0022): schema correctness is a
    // deploy-time job. Hydrate sets no `verifyMarker` and reads no database.
    const widget = dataContract<WidgetContract>(widgetContractJson);
    const dep = postgres(widget);

    expect(() =>
      dep.connection.hydrate({ url: 'postgres://user:pass@localhost:5432/any-db' }),
    ).not.toThrow();
  });
});
