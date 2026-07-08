import { describe, expect, test } from 'bun:test';
import type { Contract } from '../contract.ts';
import { Load, LoadError } from '../graph.ts';
import type { ProvisionedRef } from '../node.ts';
import { connectionEnd, hex, resource, service } from '../node.ts';
import { conn } from './helpers.ts';

const build = { kind: 'node', entry: 'server.js' };

const dbResource = () =>
  resource({
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
    type: 'fake/compute',
    inputs: { db: dbResource() },
    params: {},
    build,
  });

const makeStorefrontService = () =>
  service({
    type: 'fake/compute',
    inputs: { auth: httpEnd() },
    params: {},
    build,
  });

const twoServiceHex = () =>
  hex('shop', (h) => {
    const authRef = h.provision('auth', makeAuthService());
    h.provision('storefront', makeStorefrontService(), { auth: authRef });
  });

describe('Load of a hex root', () => {
  test('executes the body, producing owned services, input edges, and connection edges', () => {
    const root = twoServiceHex();

    const graph = Load(root);

    expect(graph.root.id).toBe('shop');
    expect(graph.root.node).toBe(root);
    expect(graph.nodes.map((n) => ({ id: n.id, kind: n.node.kind }))).toEqual([
      { id: 'auth.db', kind: 'resource' },
      { id: 'auth', kind: 'service' },
      { id: 'storefront.auth', kind: 'connection' },
      { id: 'storefront', kind: 'service' },
      { id: 'shop', kind: 'hex' },
    ]);
    expect(graph.edges).toEqual([
      { from: 'auth.db', to: 'auth', input: 'db', kind: 'input' },
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

  test('duplicate provision ids are a LoadError', () => {
    const root = hex('shop', (h) => {
      h.provision('auth', makeAuthService());
      h.provision('auth', makeAuthService());
    });

    expect(() => Load(root)).toThrow(LoadError);
    expect(() => Load(root)).toThrow(/Duplicate provision id "auth"/);
  });

  test('a dangling ConnectionEnd input names the service and the input', () => {
    const root = hex('shop', (h) => {
      h.provision('auth', makeAuthService());
      h.provision('storefront', makeStorefrontService()); // auth input left unwired
    });

    expect(() => Load(root)).toThrow(LoadError);
    expect(() => Load(root)).toThrow(/"auth" of provisioned service "storefront" is not wired/);
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

  test('wiring a name that is not a ConnectionEnd input is a LoadError', () => {
    const root = hex('shop', (h) => {
      const authRef = h.provision('auth', makeAuthService());
      // "db" is a resource input on auth — not wireable.
      h.provision('other', makeAuthService(), { db: authRef });
    });

    expect(() => Load(root)).toThrow(LoadError);
    expect(() => Load(root)).toThrow(/"db", which is not a ConnectionEnd input/);
  });

  test('builder layer: refs are only obtainable from provision() — honest wiring is create-then-wire', () => {
    // The API hands a ref back only after the producer is provisioned, so an
    // honest body cannot express a forward reference, let alone a cycle.
    const seen: string[] = [];
    const root = hex('shop', (h) => {
      const ref = h.provision('auth', makeAuthService());
      seen.push(ref.id);
      h.provision('storefront', makeStorefrontService(), { auth: ref });
    });

    Load(root);

    expect(seen).toEqual(['auth']);
  });

  test('graph layer: a 2-cycle (forged refs) is a LoadError naming both nodes', () => {
    const a = service({
      type: 'fake/compute',
      inputs: { peer: httpEnd() },
      params: {},
      build,
    });
    const b = service({
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

  test('a lone service Loaded directly may have unwired ConnectionEnds', () => {
    const lone = makeStorefrontService();

    const graph = Load(lone, { id: 'storefront' });

    expect(graph.edges).toEqual([
      { from: 'storefront.auth', to: 'storefront', input: 'auth', kind: 'input' },
    ]);
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
    service({ type: 'fake/compute', inputs: {}, params: {}, build, expose: { rpc: exposed } });

  const makeTypedStorefrontService = () =>
    service({
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
