import { describe, expect, test } from 'bun:test';
import type { Contract } from '../contract.ts';
import { Load, LoadError } from '../graph.ts';
import type { ProvisionedRef, ResourceRef } from '../node.ts';
import { connectionEnd, hex, resource, resourceEnd, service } from '../node.ts';
import { conn } from './helpers.ts';

const build = {
  kind: 'node',
  pack: '@makerkit/node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};

const dbResource = () => resource({ name: 'db', pack: 'test/pack', type: 'fake/db' });

const dbEnd = () =>
  resourceEnd({
    name: 'db',
    type: 'fake/db',
    connection: conn({ url: { type: 'string', secret: true } }, (v) => ({ url: v.url })),
  });

const httpEnd = () =>
  connectionEnd({
    type: 'fake/http',
    connection: conn({ url: { type: 'string' } }, (v) => ({ url: v.url })),
  });

const makeAuthService = () =>
  service({
    name: 'test-service',
    pack: 'test/pack',
    type: 'fake/compute',
    inputs: { db: dbEnd() },
    params: {},
    build,
  });

const makeStorefrontService = () =>
  service({
    name: 'test-service',
    pack: 'test/pack',
    type: 'fake/compute',
    inputs: { auth: httpEnd() },
    params: {},
    build,
  });

const twoServiceHex = () =>
  hex('shop', (h) => {
    const db = h.provision('db', dbResource());
    const authRef = h.provision('auth', makeAuthService(), { db });
    h.provision('storefront', makeStorefrontService(), { auth: authRef });
  });

describe('Load of a hex root', () => {
  test('executes the body, producing owned resources and services, input edges, and resource/connection edges', () => {
    const root = twoServiceHex();

    const graph = Load(root);

    expect(graph.root.id).toBe('shop');
    expect(graph.root.node).toBe(root);
    expect(graph.nodes.map((n) => ({ id: n.id, kind: n.node.kind }))).toEqual([
      { id: 'db', kind: 'resource' },
      { id: 'auth.db', kind: 'resource-end' },
      { id: 'auth', kind: 'service' },
      { id: 'storefront.auth', kind: 'connection' },
      { id: 'storefront', kind: 'service' },
      { id: 'shop', kind: 'hex' },
    ]);
    expect(graph.edges).toEqual([
      { from: 'auth.db', to: 'auth', input: 'db', kind: 'input' },
      { from: 'db', to: 'auth', input: 'db', kind: 'resource' },
      { from: 'storefront.auth', to: 'storefront', input: 'auth', kind: 'input' },
      { from: 'auth', to: 'storefront', input: 'auth', kind: 'connection' },
    ]);
  });

  test('opts.id overrides the hex name as root id', () => {
    const graph = Load(twoServiceHex(), { id: 'prod' });

    expect(graph.root.id).toBe('prod');
    // Provision ids are hex-local and unaffected by the root id.
    expect(graph.nodes.map((n) => n.id)).toContain('auth');
  });

  test('the body runs at Load, not at construction', () => {
    let bodyCalls = 0;
    const svc = service({
      name: 'test-service',
      pack: 'test/pack',
      type: 'fake/compute',
      inputs: {},
      params: {},
      build,
    });
    const root = hex('shop', (h) => {
      bodyCalls += 1;
      h.provision('only', svc);
    });

    expect(bodyCalls).toBe(0);
    Load(root);
    expect(bodyCalls).toBe(1);
  });

  test('duplicate provision ids are a LoadError — resources and services share one id space', () => {
    const root = hex('shop', (h) => {
      h.provision('auth', dbResource());
      const db = h.provision('db', dbResource());
      h.provision('auth', makeAuthService(), { db });
    });

    expect(() => Load(root)).toThrow(LoadError);
    expect(() => Load(root)).toThrow(/Duplicate provision id "auth"/);
  });

  test('a provision id containing "_" or "." is a LoadError (config-key / node-id separator collision)', () => {
    // "auth_db" + param "url" would serialize to the same env key as
    // "auth" + input "db" + param "url" (both AUTH_DB_URL).
    const underscored = hex('shop', (h) => {
      h.provision('auth_db', makeAuthService());
    });
    expect(() => Load(underscored)).toThrow(/id "auth_db" \(hex "shop"\) may not contain/);

    const dotted = hex('shop', (h) => {
      h.provision('auth.db', makeAuthService());
    });
    expect(() => Load(dotted)).toThrow(/id "auth.db" \(hex "shop"\) may not contain/);
  });

  test('a dangling ConnectionEnd input names the service and the input', () => {
    const root = hex('shop', (h) => {
      const db = h.provision('db', dbResource());
      h.provision('auth', makeAuthService(), { db });
      h.provision('storefront', makeStorefrontService()); // auth input left unwired
    });

    expect(() => Load(root)).toThrow(LoadError);
    expect(() => Load(root)).toThrow(
      /ConnectionEnd input "auth" of provisioned service "storefront" is not wired/,
    );
  });

  test('wiring to an unknown producer id is a LoadError', () => {
    const root = hex('shop', (h) => {
      h.provision('storefront', makeStorefrontService(), {
        auth: { id: 'nope' } as ProvisionedRef,
      });
    });

    expect(() => Load(root)).toThrow(LoadError);
    expect(() => Load(root)).toThrow(/"storefront.auth" references "nope"/);
  });

  test('wiring a name that is not a dependency slot of the service is a LoadError', () => {
    const root = hex('shop', (h) => {
      const db = h.provision('db', dbResource());
      const authRef = h.provision('auth', makeAuthService(), { db });
      h.provision('other', makeStorefrontService(), { auth: authRef, extra: authRef } as never);
    });

    expect(() => Load(root)).toThrow(LoadError);
    expect(() => Load(root)).toThrow(/"extra", which is not a dependency slot/);
  });

  test('builder layer: refs are only obtainable from provision() — honest wiring is create-then-wire', () => {
    // The API hands a ref back only after the producer is provisioned, so an
    // honest body cannot express a forward reference, let alone a cycle.
    const seen: string[] = [];
    const root = hex('shop', (h) => {
      const db = h.provision('db', dbResource());
      const ref = h.provision('auth', makeAuthService(), { db });
      seen.push(ref.id);
      h.provision('storefront', makeStorefrontService(), { auth: ref });
    });

    Load(root);

    expect(seen).toEqual(['auth']);
  });

  test('graph layer: a 2-cycle (forged refs) is a LoadError naming both nodes', () => {
    const a = service({
      name: 'test-service',
      pack: 'test/pack',
      type: 'fake/compute',
      inputs: { peer: httpEnd() },
      params: {},
      build,
    });
    const b = service({
      name: 'test-service',
      pack: 'test/pack',
      type: 'fake/compute',
      inputs: { peer: httpEnd() },
      params: {},
      build,
    });
    const root = hex('shop', (h) => {
      // Forged ref: the builder API cannot produce this — the DAG check can.
      h.provision('a', a, { peer: { id: 'b' } as ProvisionedRef });
      h.provision('b', b, { peer: { id: 'a' } as ProvisionedRef });
    });

    expect(() => Load(root)).toThrow(LoadError);
    expect(() => Load(root)).toThrow(/Connection cycle/);
    try {
      Load(root);
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('a');
      expect(message).toContain('b');
      expect(message).toMatch(/(a → b → a|b → a → b)/);
    }
  });

  test('topo sort: a hex authored consumer-before-producer (forged ref) places the producer before the consumer in graph.nodes', () => {
    // Forged ref: normal authoring cannot reference a producer before
    // provisioning it (provision() is the only source of a ref) — this
    // hand-builds one pointing at "auth", which the body provisions AFTER
    // storefront, so authored order and dependency order disagree.
    const root = hex('shop', (h) => {
      h.provision('storefront', makeStorefrontService(), {
        auth: { id: 'auth' } as ProvisionedRef,
      });
      const db = h.provision('db', dbResource());
      h.provision('auth', makeAuthService(), { db });
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

  test('a lone service Loaded directly with an unwired ConnectionEnd input is a LoadError naming the input and pointing at the composing hex', () => {
    const lone = makeStorefrontService();

    expect(() => Load(lone, { id: 'storefront' })).toThrow(LoadError);
    expect(() => Load(lone, { id: 'storefront' })).toThrow(
      /"storefront" has an unwired connection input "auth".*composed by a hex.*deploy the hex/s,
    );
  });
});

describe('Load of a hex root — provisioned resources', () => {
  test('one provisioned resource wired to two services: exactly one resource node, one resource edge per consumer', () => {
    const root = hex('shop', (h) => {
      const db = h.provision('db', dbResource());
      h.provision('auth', makeAuthService(), { db });
      h.provision('billing', makeAuthService(), { db });
    });

    const graph = Load(root);

    const resourceNodes = graph.nodes.filter((n) => n.node.kind === 'resource');
    expect(resourceNodes.map((n) => n.id)).toEqual(['db']);
    expect(graph.edges.filter((e) => e.kind === 'resource')).toEqual([
      { from: 'db', to: 'auth', input: 'db', kind: 'resource' },
      { from: 'db', to: 'billing', input: 'db', kind: 'resource' },
    ]);
  });

  test('provision() hands back a frozen ResourceRef carrying the id and resource type', () => {
    let ref: ResourceRef<'fake/db'> | undefined;
    Load(
      hex('shop', (h) => {
        ref = h.provision('db', dbResource());
      }),
    );

    expect(ref).toEqual({ id: 'db', type: 'fake/db' });
    expect(Object.isFrozen(ref)).toBe(true);
  });

  test('wiring a ResourceEnd to a resource of another type is a LoadError naming both types', () => {
    const cache = resource({ name: 'cache', pack: 'test/pack', type: 'fake/cache' });
    const root = hex('shop', (h) => {
      const cacheRef = h.provision('cache', cache);
      // TypeScript already rejects this wiring at the call site (see
      // hex-wiring.test-d.ts) — this exercises the runtime backstop directly,
      // as if that check were bypassed by a cast.
      h.provision('auth', makeAuthService(), { db: cacheRef as never });
    });

    expect(() => Load(root)).toThrow(LoadError);
    expect(() => Load(root)).toThrow(
      /"auth.db" requires a resource of type "fake\/db", but "cache" is of type "fake\/cache"/,
    );
  });

  test("wiring a ResourceEnd to a provisioned service's ref is a LoadError", () => {
    const root = hex('shop', (h) => {
      const db = h.provision('db', dbResource());
      const other = h.provision('other', makeAuthService(), { db });
      h.provision('auth', makeAuthService(), { db: other as never });
    });

    expect(() => Load(root)).toThrow(LoadError);
    expect(() => Load(root)).toThrow(
      /"auth.db" references "other", which is not a provisioned resource/,
    );
  });

  test("wiring a ConnectionEnd to a provisioned resource's ref is a LoadError", () => {
    const root = hex('shop', (h) => {
      const db = h.provision('db', dbResource());
      h.provision('storefront', makeStorefrontService(), { auth: db as never });
    });

    expect(() => Load(root)).toThrow(LoadError);
    expect(() => Load(root)).toThrow(
      /"storefront.auth" references "db", which is not a provisioned service/,
    );
  });

  test('a dangling ResourceEnd input names the service and the input', () => {
    const root = hex('shop', (h) => {
      h.provision('db', dbResource());
      h.provision('auth', makeAuthService()); // db input left unwired
    });

    expect(() => Load(root)).toThrow(LoadError);
    expect(() => Load(root)).toThrow(
      /ResourceEnd input "db" of provisioned service "auth" is not wired/,
    );
  });

  test('passing wiring to a resource provision is a LoadError — a resource has no inputs', () => {
    const root = hex('shop', (h) => {
      // TypeScript's overloads reject wiring on a resource provision — forged
      // here to exercise the runtime backstop.
      h.provision('db', dbResource() as never, {} as never);
    });

    expect(() => Load(root)).toThrow(LoadError);
    expect(() => Load(root)).toThrow(
      /provision\("db"\) received wiring for a resource — a resource has no inputs to wire/,
    );
  });
});

describe('importing a hex module', () => {
  test('runs nothing — only Loading may run the body (invariant 3)', async () => {
    const fixture = await import('./fixtures/side-effect-hex.ts');

    expect(fixture.bodyCallCount).toBe(0);

    Load(fixture.default);
    expect(fixture.bodyCallCount).toBe(1);
  });
});

describe('Load of a hex root — typed ConnectionEnd wiring (the satisfies() backstop)', () => {
  // A minimal Contract, nominal like @makerkit/rpc's own: satisfies() is
  // identity, so a ref-port only satisfies the contract it was actually built
  // from — mirrors what a cast-bypassed wrong wiring would look like at
  // runtime (TypeScript already rejects this at the call site — see
  // @makerkit/rpc's contract-satisfaction.test-d.ts).
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

  const typedAuthEnd = () =>
    connectionEnd({
      type: 'fake/rpc',
      connection: conn({ url: { type: 'string' } }, (v) => ({ url: v.url })),
      required: authContract,
    });

  const makeContractProvider = <C extends Contract<'rpc', unknown>>(exposed: C) =>
    service({
      name: 'test-service',
      pack: 'test/pack',
      type: 'fake/compute',
      inputs: {},
      params: {},
      build,
      expose: { rpc: exposed },
    });

  const makeTypedStorefrontService = () =>
    service({
      name: 'test-service',
      pack: 'test/pack',
      type: 'fake/compute',
      inputs: { auth: typedAuthEnd() },
      params: {},
      build,
    });

  test('a ref-port whose contract satisfies the required one loads without error', () => {
    const root = hex('shop', (h) => {
      const authRef = h.provision('auth', makeContractProvider(authContract));
      h.provision('storefront', makeTypedStorefrontService(), { auth: authRef.rpc });
    });

    expect(() => Load(root)).not.toThrow();
  });

  test('a ref-port whose contract does not satisfy the required one is a LoadError', () => {
    const root = hex('shop', (h) => {
      const wrongRef = h.provision('payments', makeContractProvider(wrongContract));
      // TypeScript already rejects this wiring at the call site — this
      // exercises the runtime backstop directly, as if that check were
      // bypassed by a cast.
      h.provision('storefront', makeTypedStorefrontService(), { auth: wrongRef.rpc as never });
    });

    expect(() => Load(root)).toThrow(LoadError);
    expect(() => Load(root)).toThrow(/"storefront.auth" does not satisfy its required contract/);
  });
});
