import { describe, expect, test } from 'bun:test';
import { string } from '../config.ts';
import type { Contract } from '../contract.ts';
import { Load, LoadError } from '../graph.ts';
import type { ProvisionedRef } from '../node.ts';
import { dependency, resource, service, system } from '../node.ts';
import { conn, providerContract } from './helpers.ts';

const build = {
  extension: '@prisma/app-node',
  type: 'node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};

const dbContract = () => providerContract('fake/db', { url: '' });

const dbResource = () => resource({ name: 'db', extension: 'test/pack', provides: dbContract() });

const dbDep = () =>
  dependency({
    name: 'db',
    type: 'fake/db',
    connection: conn({ url: string({ secret: true }) }, (v) => ({ url: v.url })),
    required: dbContract(),
  });

const httpDep = () =>
  dependency({
    type: 'fake/http',
    connection: conn({ url: string() }, (v) => ({ url: v.url })),
  });

const makeAuthService = () =>
  service({
    name: 'test-service',
    extension: 'test/pack',
    type: 'fake/compute',
    inputs: { db: dbDep() },
    params: {},
    build,
  });

const makeStorefrontService = () =>
  service({
    name: 'test-service',
    extension: 'test/pack',
    type: 'fake/compute',
    inputs: { auth: httpDep() },
    params: {},
    build,
  });

const twoServiceSystem = () =>
  system('shop', {}, (h) => {
    const db = h.provision('db', dbResource());
    const authRef = h.provision('auth', makeAuthService(), { db });
    h.provision('storefront', makeStorefrontService(), { auth: authRef });
    return {};
  });

describe('Load of a system root', () => {
  test('executes the body, producing owned resources and services, input edges, and dependency edges', () => {
    const root = twoServiceSystem();

    const graph = Load(root);

    expect(graph.root.id).toBe('shop');
    expect(graph.root.node).toBe(root);
    expect(graph.nodes.map((n) => ({ id: n.id, kind: n.node.kind }))).toEqual([
      { id: 'db', kind: 'resource' },
      { id: 'auth.db', kind: 'dependency' },
      { id: 'auth', kind: 'service' },
      { id: 'storefront.auth', kind: 'dependency' },
      { id: 'storefront', kind: 'service' },
      { id: 'shop', kind: 'system' },
    ]);
    expect(graph.edges).toEqual([
      { from: 'auth.db', to: 'auth', input: 'db', kind: 'input' },
      { from: 'db', to: 'auth', input: 'db', kind: 'dependency' },
      { from: 'storefront.auth', to: 'storefront', input: 'auth', kind: 'input' },
      { from: 'auth', to: 'storefront', input: 'auth', kind: 'dependency' },
    ]);
  });

  test('opts.id overrides the system name as root id', () => {
    const graph = Load(twoServiceSystem(), { id: 'prod' });

    expect(graph.root.id).toBe('prod');
    // Provision ids are system-local and unaffected by the root id.
    expect(graph.nodes.map((n) => n.id)).toContain('auth');
  });

  test('the body runs at Load, not at construction', () => {
    let bodyCalls = 0;
    const svc = service({
      name: 'test-service',
      extension: 'test/pack',
      type: 'fake/compute',
      inputs: {},
      params: {},
      build,
    });
    const root = system('shop', {}, (h) => {
      bodyCalls += 1;
      h.provision('only', svc);
      return {};
    });

    expect(bodyCalls).toBe(0);
    Load(root);
    expect(bodyCalls).toBe(1);
  });

  test('duplicate provision ids are a LoadError — resources and services share one id space', () => {
    const root = system('shop', {}, (h) => {
      h.provision('auth', dbResource());
      const db = h.provision('db', dbResource());
      h.provision('auth', makeAuthService(), { db });
      return {};
    });

    expect(() => Load(root)).toThrow(LoadError);
    expect(() => Load(root)).toThrow(/Duplicate provision id "auth"/);
  });

  test('a provision id containing "_" or "." is a LoadError naming the separators', () => {
    const root = system('shop', {}, (h) => {
      h.provision('auth_db', dbResource());
      return {};
    });

    expect(() => Load(root)).toThrow(LoadError);
    expect(() => Load(root)).toThrow(/id "auth_db" \(system "shop"\) may not contain "_" or "\."/);
  });

  test('a dangling dependency input names the service and the input', () => {
    const root = system('shop', {}, (h) => {
      const db = h.provision('db', dbResource());
      h.provision('auth', makeAuthService(), { db });
      h.provision('storefront', makeStorefrontService()); // auth input left unwired
      return {};
    });

    expect(() => Load(root)).toThrow(LoadError);
    expect(() => Load(root)).toThrow(
      /Dependency input "auth" of provisioned service "storefront" is not wired/,
    );
  });

  test('wiring to an unknown producer id is a LoadError', () => {
    const root = system('shop', {}, (h) => {
      h.provision('storefront', makeStorefrontService(), {
        auth: { id: 'nope' } as ProvisionedRef,
      });
      return {};
    });

    expect(() => Load(root)).toThrow(LoadError);
    expect(() => Load(root)).toThrow(/"storefront.auth" references "nope"/);
  });

  test('wiring a name that is not a dependency slot of the service is a LoadError', () => {
    const root = system('shop', {}, (h) => {
      const db = h.provision('db', dbResource());
      const authRef = h.provision('auth', makeAuthService(), { db });
      h.provision('other', makeStorefrontService(), { auth: authRef, extra: authRef } as never);
      return {};
    });

    expect(() => Load(root)).toThrow(LoadError);
    expect(() => Load(root)).toThrow(/"extra", which is not a dependency slot/);
  });

  test('builder layer: refs are only obtainable from provision() — honest wiring is create-then-wire', () => {
    // The API hands a ref back only after the producer is provisioned, so an
    // honest body cannot express a forward reference, let alone a cycle.
    const seen: string[] = [];
    const root = system('shop', {}, (h) => {
      const db = h.provision('db', dbResource());
      const ref = h.provision('auth', makeAuthService(), { db });
      seen.push(ref.id);
      h.provision('storefront', makeStorefrontService(), { auth: ref });
      return {};
    });

    Load(root);

    expect(seen).toEqual(['auth']);
  });

  test('graph layer: a 2-cycle (forged refs) is a LoadError naming both nodes', () => {
    const a = service({
      name: 'test-service',
      extension: 'test/pack',
      type: 'fake/compute',
      inputs: { peer: httpDep() },
      params: {},
      build,
    });
    const b = service({
      name: 'test-service',
      extension: 'test/pack',
      type: 'fake/compute',
      inputs: { peer: httpDep() },
      params: {},
      build,
    });
    const root = system('shop', {}, (h) => {
      // Forged ref: the builder API cannot produce this — the DAG check can.
      h.provision('a', a, { peer: { id: 'b' } as ProvisionedRef });
      h.provision('b', b, { peer: { id: 'a' } as ProvisionedRef });
      return {};
    });

    expect(() => Load(root)).toThrow(LoadError);
    expect(() => Load(root)).toThrow(/Dependency cycle/);
    try {
      Load(root);
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('a');
      expect(message).toContain('b');
      expect(message).toMatch(/(a → b → a|b → a → b)/);
    }
  });

  test('topo sort: a system authored consumer-before-producer (forged ref) places the producer before the consumer in graph.nodes', () => {
    // Forged ref: normal authoring cannot reference a producer before
    // provisioning it (provision() is the only source of a ref) — this
    // hand-builds one pointing at "auth", which the body provisions AFTER
    // storefront, so authored order and dependency order disagree.
    const root = system('shop', {}, (h) => {
      h.provision('storefront', makeStorefrontService(), {
        auth: { id: 'auth' } as ProvisionedRef,
      });
      const db = h.provision('db', dbResource());
      h.provision('auth', makeAuthService(), { db });
      return {};
    });

    const graph = Load(root);

    expect(graph.nodes.map((n) => n.id)).toEqual([
      'storefront.auth',
      'db',
      'auth.db',
      'auth',
      'storefront',
      'shop',
    ]);
    const authIndex = graph.nodes.findIndex((n) => n.id === 'auth');
    const storefrontIndex = graph.nodes.findIndex((n) => n.id === 'storefront');
    expect(authIndex).toBeLessThan(storefrontIndex);
  });

  test('a lone service Loaded directly with an unwired dependency input is a LoadError naming the input and pointing at the composing system', () => {
    const lone = makeStorefrontService();

    expect(() => Load(lone, { id: 'storefront' })).toThrow(LoadError);
    expect(() => Load(lone, { id: 'storefront' })).toThrow(
      /"storefront" has an unwired dependency input "auth".*composed by a system.*deploy the system/s,
    );
  });
});

describe('Load of a system root — provisioned resources', () => {
  test('one provisioned resource wired to two services: exactly one resource node, one dependency edge per consumer', () => {
    const root = system('shop', {}, (h) => {
      const db = h.provision('db', dbResource());
      h.provision('auth', makeAuthService(), { db });
      h.provision('billing', makeAuthService(), { db });
      return {};
    });

    const graph = Load(root);

    const resourceNodes = graph.nodes.filter((n) => n.node.kind === 'resource');
    expect(resourceNodes.map((n) => n.id)).toEqual(['db']);
    expect(graph.edges.filter((e) => e.kind === 'dependency')).toEqual([
      { from: 'db', to: 'auth', input: 'db', kind: 'dependency' },
      { from: 'db', to: 'billing', input: 'db', kind: 'dependency' },
    ]);
  });

  test("provision() hands back the resource's contract as its ref, tagged with the id", () => {
    let ref: ({ id: string } & Contract<'fake/db', { url: string }>) | undefined;
    Load(
      system('shop', {}, (h) => {
        ref = h.provision('db', dbResource());
        return {};
      }),
    );

    expect(ref?.id).toBe('db');
    expect(ref?.kind).toBe('fake/db');
    expect(typeof ref?.satisfies).toBe('function');
  });

  test('wiring a slot to a resource whose contract has another kind is a LoadError', () => {
    const cache = resource({
      name: 'cache',
      extension: 'test/pack',
      provides: providerContract('fake/cache', {}),
    });
    const root = system('shop', {}, (h) => {
      const cacheRef = h.provision('cache', cache);
      // TypeScript already rejects this wiring at the call site (see
      // system-wiring.test-d.ts) — this exercises the runtime backstop directly,
      // as if that check were bypassed by a cast.
      h.provision('auth', makeAuthService(), { db: cacheRef as never });
      return {};
    });

    expect(() => Load(root)).toThrow(LoadError);
    expect(() => Load(root)).toThrow(/"auth.db" does not satisfy its required contract/);
  });

  test('wiring a contract-requiring slot to a bare service ref (no matching port) is a LoadError', () => {
    const root = system('shop', {}, (h) => {
      const db = h.provision('db', dbResource());
      const other = h.provision('other', makeAuthService(), { db });
      h.provision('auth', makeAuthService(), { db: other as never });
      return {};
    });

    expect(() => Load(root)).toThrow(LoadError);
    expect(() => Load(root)).toThrow(/"auth.db" does not satisfy its required contract/);
  });

  test("an untyped slot accepts a resource ref — uniformity's escape hatch, unchecked by design", () => {
    const root = system('shop', {}, (h) => {
      const db = h.provision('db', dbResource());
      h.provision('storefront', makeStorefrontService(), { auth: db });
      return {};
    });

    const graph = Load(root);

    expect(graph.edges.filter((e) => e.kind === 'dependency')).toEqual([
      { from: 'db', to: 'storefront', input: 'auth', kind: 'dependency' },
    ]);
  });

  test('a dangling dependency input on a resource consumer names the service and the input', () => {
    const root = system('shop', {}, (h) => {
      h.provision('db', dbResource());
      h.provision('auth', makeAuthService()); // db input left unwired
      return {};
    });

    expect(() => Load(root)).toThrow(LoadError);
    expect(() => Load(root)).toThrow(
      /Dependency input "db" of provisioned service "auth" is not wired/,
    );
  });

  test('passing wiring to a resource provision is a LoadError — a resource has no inputs', () => {
    const root = system('shop', {}, (h) => {
      // TypeScript's overloads reject wiring on a resource provision — forged
      // here to exercise the runtime backstop.
      h.provision('db', dbResource() as never, {} as never);
      return {};
    });

    expect(() => Load(root)).toThrow(LoadError);
    expect(() => Load(root)).toThrow(
      /provision\("db"\) received wiring for a resource — a resource has no inputs to wire/,
    );
  });
});

describe('importing a system module', () => {
  test('runs nothing — only Loading may run the body (invariant 3)', async () => {
    const fixture = await import('./fixtures/side-effect-system.ts');

    expect(fixture.bodyCallCount).toBe(0);

    Load(fixture.default);
    expect(fixture.bodyCallCount).toBe(1);
  });
});

describe('Load of a system root — typed wiring (the satisfies() backstop)', () => {
  // A minimal Contract, nominal like @prisma/app-rpc's own: satisfies() is
  // identity, so a ref-port only satisfies the contract it was actually built
  // from — mirrors what a cast-bypassed wrong wiring would look like at
  // runtime (TypeScript already rejects this at the call site — see
  // @prisma/app-rpc's contract-satisfaction.test-d.ts).
  const fakeContract = <Cmp>(cmp: Cmp): Contract<'rpc', Cmp> => {
    const value: Contract<'rpc', Cmp> = {
      kind: 'rpc',
      __cmp: cmp,
      satisfies: (required) => value === required,
    };
    return value;
  };

  const authContract = fakeContract({ verify: async () => ({ ok: true }) });
  const wrongContract = fakeContract({ charge: async () => ({ id: '1' }) });

  const typedAuthDep = () =>
    dependency({
      type: 'fake/rpc',
      connection: conn({ url: string() }, (v) => ({ url: v.url })),
      required: authContract,
    });

  const makeContractProvider = <C extends Contract<'rpc', unknown>>(exposed: C) =>
    service({
      name: 'test-service',
      extension: 'test/pack',
      type: 'fake/compute',
      inputs: {},
      params: {},
      build,
      expose: { rpc: exposed },
    });

  const makeTypedStorefrontService = () =>
    service({
      name: 'test-service',
      extension: 'test/pack',
      type: 'fake/compute',
      inputs: { auth: typedAuthDep() },
      params: {},
      build,
    });

  test('a ref-port whose contract satisfies the required one loads without error', () => {
    const root = system('shop', {}, (h) => {
      const authRef = h.provision('auth', makeContractProvider(authContract));
      h.provision('storefront', makeTypedStorefrontService(), { auth: authRef.rpc });
      return {};
    });

    expect(() => Load(root)).not.toThrow();
  });

  test('a ref-port whose contract does not satisfy the required one is a LoadError', () => {
    const root = system('shop', {}, (h) => {
      const wrongRef = h.provision('payments', makeContractProvider(wrongContract));
      // TypeScript already rejects this wiring at the call site — this
      // exercises the runtime backstop directly, as if that check were
      // bypassed by a cast.
      h.provision('storefront', makeTypedStorefrontService(), { auth: wrongRef.rpc as never });
      return {};
    });

    expect(() => Load(root)).toThrow(LoadError);
    expect(() => Load(root)).toThrow(/"storefront.auth" does not satisfy its required contract/);
  });
});
