/**
 * The hex boundary (ADR-0014): `deps`/`expose` on `hex()`, forwarding through
 * the body, `provision()` accepting a hex, and Load's boundary validation
 * errors plus recursive flattening into hierarchical addresses. `hex.test.ts`
 * covers the pre-boundary Load mechanics (still exercised by an
 * empty-boundary hex); this file covers what the boundary adds on top.
 */
import { describe, expect, test } from 'bun:test';
import type { Contract } from '../contract.ts';
import { Load, LoadError } from '../graph.ts';
import type { ProvisionedRef } from '../node.ts';
import { dependency, hex, resource, service } from '../node.ts';
import { conn, providerContract } from './helpers.ts';

const build = {
  kind: 'node',
  pack: '@prisma/app-node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};

// A minimal Contract, nominal like @prisma/app-rpc's own: satisfies() is
// identity, so a ref-port only satisfies the contract it was actually built
// from — mirrors what a cast-bypassed wrong wiring would look like at
// runtime (see hex.test.ts's own copy of this pattern).
const fakeContract = <Cmp>(cmp: Cmp): Contract<'rpc', Cmp> => {
  const value: Contract<'rpc', Cmp> = {
    kind: 'rpc',
    __cmp: cmp,
    satisfies: (required) => value === required,
  };
  return value;
};

const untypedEnd = () =>
  dependency({
    type: 'fake/http',
    connection: conn({ url: { type: 'string' } }, (v) => ({ url: v.url })),
  });

const noOpService = () =>
  service({
    name: 'noop',
    pack: 'test/pack',
    type: 'fake/compute',
    inputs: {},
    params: {},
    build,
  });

describe('a hex with a declared dep that is never forwarded (Load error a)', () => {
  test('names the hex and the input, and points at the fix', () => {
    const brokenAuthHex = () =>
      hex('auth', { deps: { db: untypedEnd() } }, ({ provision }) => {
        provision('api', noOpService()); // never uses ctx.inputs.db
        return {};
      });

    const root = hex('shop', {}, ({ provision }) => {
      const dbRef = provision('dbProvider', noOpService());
      provision('auth', brokenAuthHex(), { db: dbRef });
      return {};
    });

    expect(() => Load(root)).toThrow(LoadError);
    expect(() => Load(root)).toThrow(
      'Hex "auth" declares input "db" but never forwards it into a provision nor returns it as an output.',
    );
  });

  test('aliasing regression: ONE producer wired into TWO inputs — forwarding one must not mark the other', () => {
    const consumer = () =>
      service({
        name: 'consumer',
        pack: 'test/pack',
        type: 'fake/compute',
        inputs: { in: untypedEnd() },
        params: {},
        build,
      });

    const aliasedHex = () =>
      hex('aliased', { deps: { a: untypedEnd(), b: untypedEnd() } }, ({ inputs, provision }) => {
        provision('c', consumer(), { in: inputs.a }); // only "a" forwarded; "b" ignored
        return {};
      });

    const root = hex('shop', {}, ({ provision }) => {
      const p = provision('p', noOpService());
      // The SAME ref wired into both inputs — without per-key ctx.inputs
      // identities, the two entries alias and forwarding "a" falsely marks "b".
      provision('x', aliasedHex(), { a: p, b: p });
      return {};
    });

    expect(() => Load(root)).toThrow(LoadError);
    expect(() => Load(root)).toThrow(
      'Hex "aliased" declares input "b" but never forwards it into a provision nor returns it as an output.',
    );
  });

  test('distinct-producer control: both inputs forwarded — Loads clean, edges carry each real producer', () => {
    const consumer = () =>
      service({
        name: 'consumer',
        pack: 'test/pack',
        type: 'fake/compute',
        inputs: { one: untypedEnd(), two: untypedEnd() },
        params: {},
        build,
      });

    const wiredHex = () =>
      hex('wired', { deps: { a: untypedEnd(), b: untypedEnd() } }, ({ inputs, provision }) => {
        provision('c', consumer(), { one: inputs.a, two: inputs.b });
        return {};
      });

    const root = hex('shop', {}, ({ provision }) => {
      const p1 = provision('p1', noOpService());
      const p2 = provision('p2', noOpService());
      provision('x', wiredHex(), { a: p1, b: p2 });
      return {};
    });

    const graph = Load(root);

    expect(graph.edges).toContainEqual({ from: 'p1', to: 'x.c', input: 'one', kind: 'dependency' });
    expect(graph.edges).toContainEqual({ from: 'p2', to: 'x.c', input: 'two', kind: 'dependency' });
  });
});

describe('a hex expose key missing from the body return or failing satisfies (Load error b)', () => {
  const authContract = fakeContract({ verify: async () => ({ ok: true }) });
  const wrongContract = fakeContract({ charge: async () => ({ id: '1' }) });

  const contractProvider = <C extends Contract<'rpc', unknown>>(exposed: C) =>
    service({
      name: 'provider',
      pack: 'test/pack',
      type: 'fake/compute',
      inputs: {},
      params: {},
      build,
      expose: { rpc: exposed },
    });

  test('a missing return for the declared key names the hex and the key', () => {
    const missingExposeHex = hex('auth', { expose: { verify: authContract } }, ({ provision }) => {
      provision('api', contractProvider(authContract));
      return {} as never; // the declared "verify" key is never returned
    });

    expect(() => Load(missingExposeHex)).toThrow(LoadError);
    expect(() => Load(missingExposeHex)).toThrow(
      'Hex "auth" declares expose "verify" but its body did not return a port for it.',
    );
  });

  test('a returned port that fails satisfies() names the hex and the key', () => {
    const wrongExposeHex = hex('auth', { expose: { verify: authContract } }, ({ provision }) => {
      const ref = contractProvider(wrongContract);
      const provided = provision('api', ref);
      // TypeScript already rejects this at the return-type check; this
      // exercises the runtime backstop, as if that check were bypassed.
      return { verify: provided.rpc as never };
    });

    expect(() => Load(wrongExposeHex)).toThrow(LoadError);
    expect(() => Load(wrongExposeHex)).toThrow(
      `Hex "auth"'s returned port for expose "verify" does not satisfy its declared contract.`,
    );
  });
});

describe('a hex with non-empty deps Loaded as root (Load error c)', () => {
  test('names the hex and the input(s), pointing at the composing hex', () => {
    const rootWithDeps = hex('auth', { deps: { db: untypedEnd() } }, ({ provision }) => {
      provision('api', noOpService());
      return {};
    });

    expect(() => Load(rootWithDeps)).toThrow(LoadError);
    expect(() => Load(rootWithDeps)).toThrow(
      'Hex "auth" declares input "db" but is being deployed as the root — a root has no enclosing ' +
        'scope to wire them; compose "auth" from another hex that provisions and wires it instead.',
    );
  });

  test('pluralizes and lists every declared input when there is more than one', () => {
    const rootWithDeps = hex(
      'auth',
      { deps: { db: untypedEnd(), cache: untypedEnd() } },
      ({ provision }) => {
        provision('api', noOpService());
        return {};
      },
    );

    expect(() => Load(rootWithDeps)).toThrow(/declares inputs "db", "cache" but is being deployed/);
  });
});

describe('a forwarding cycle through a hex boundary (Load error d)', () => {
  const peerService = () =>
    service({
      name: 'peer-svc',
      pack: 'test/pack',
      type: 'fake/compute',
      inputs: { peer: untypedEnd() },
      params: {},
      build,
    });

  test('the DAG check sees through the boundary — the cycle is named by full address', () => {
    // 'sub' honestly forwards its declared "peer" input into its own child
    // ("inner") — an ordinary down-forward, no forging needed for that half.
    const subHex = () =>
      hex('sub', { deps: { peer: untypedEnd() } }, ({ inputs, provision }) => {
        provision('inner', peerService(), { peer: inputs.peer });
        return {};
      });

    const root = hex('shop', {}, ({ provision }) => {
      // The only forgery: 'a' names "sub.inner" — a full hierarchical
      // address — before "sub" (let alone "sub.inner") is provisioned. An
      // honest body cannot express this forward reference (refs are only
      // returned after provision()); the DAG check is what catches it.
      const forged = { id: 'sub.inner' } as ProvisionedRef;
      const aRef = provision('a', peerService(), { peer: forged });
      provision('sub', subHex(), { peer: aRef }); // a → sub.inner (honest forward)
      return {};
    });

    expect(() => Load(root)).toThrow(LoadError);
    expect(() => Load(root)).toThrow(/Dependency cycle/);
    try {
      Load(root);
      throw new Error('expected Load to throw');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('a');
      expect(message).toContain('sub.inner');
    }
  });
});

describe('3-level nesting: addresses, and forwarding down + up round trip', () => {
  const cfgContract = fakeContract({ get: async () => 'v' });
  const outContract = fakeContract({ ping: async () => 'pong' });

  const cfgEnd = () =>
    dependency({
      type: 'fake/rpc-cfg',
      connection: conn({ url: { type: 'string' } }, (v) => ({ url: v.url })),
      required: cfgContract,
    });

  const outEnd = () =>
    dependency({
      type: 'fake/rpc-out',
      connection: conn({ url: { type: 'string' } }, (v) => ({ url: v.url })),
      required: outContract,
    });

  const configService = () =>
    service({
      name: 'config',
      pack: 'test/pack',
      type: 'fake/compute',
      inputs: {},
      params: {},
      build,
      expose: { cfg: cfgContract },
    });

  const leafService = () =>
    service({
      name: 'leaf',
      pack: 'test/pack',
      type: 'fake/compute',
      inputs: { cfg: cfgEnd() },
      params: {},
      build,
      expose: { out: outContract },
    });

  const sinkService = () =>
    service({
      name: 'sink',
      pack: 'test/pack',
      type: 'fake/compute',
      inputs: { out: outEnd() },
      params: {},
      build,
    });

  // inner (depth 2) forwards its "cfg" input down into "leaf", and forwards
  // leaf's "out" port up as its own expose.
  const innerHex = () =>
    hex(
      'inner',
      { deps: { cfg: cfgEnd() }, expose: { out: outContract } },
      ({ inputs, provision }) => {
        const leaf = provision('leaf', leafService(), { cfg: inputs.cfg });
        return { out: leaf.out };
      },
    );

  // mid (depth 1) does the same one level up — a pure pass-through of both
  // directions, proving forwarding composes across more than one boundary.
  const midHex = () =>
    hex(
      'mid',
      { deps: { cfg: cfgEnd() }, expose: { out: outContract } },
      ({ inputs, provision }) => {
        const inner = provision('inner', innerHex(), { cfg: inputs.cfg });
        return { out: inner.out };
      },
    );

  const rootHex = () =>
    hex('app', {}, ({ provision }) => {
      const cfg = provision('config', configService());
      const mid = provision('mid', midHex(), { cfg: cfg.cfg });
      provision('sink', sinkService(), { out: mid.out });
      return {};
    });

  test('flattens 3 levels deep with hierarchical, dot-joined addresses', () => {
    const graph = Load(rootHex(), { id: 'app' });

    const ids = graph.nodes.map((n) => n.id);
    expect(ids).toContain('config');
    expect(ids).toContain('mid');
    expect(ids).toContain('mid.inner');
    expect(ids).toContain('mid.inner.leaf');
    expect(ids).toContain('mid.inner.leaf.cfg');
    expect(ids).toContain('sink');
    expect(ids).toContain('sink.out');
    expect(ids).toContain('app');

    const kindOf = (id: string) => graph.nodes.find((n) => n.id === id)?.node.kind;
    expect(kindOf('mid')).toBe('hex');
    expect(kindOf('mid.inner')).toBe('hex');
    expect(kindOf('mid.inner.leaf')).toBe('service');
  });

  test('an input forwarded down 2 levels resolves to the real (top-level) producer', () => {
    const graph = Load(rootHex());

    expect(graph.edges).toContainEqual({
      from: 'config',
      to: 'mid.inner.leaf',
      input: 'cfg',
      kind: 'dependency',
    });
  });

  test('an output forwarded up 2 levels resolves to the real (deepest) producer', () => {
    const graph = Load(rootHex());

    expect(graph.edges).toContainEqual({
      from: 'mid.inner.leaf',
      to: 'sink',
      input: 'out',
      kind: 'dependency',
    });
  });

  test('a single-level hex keeps bare, unprefixed ids — nesting changes nothing about the flat case', () => {
    const flat = hex('shop', {}, ({ provision }) => {
      provision('config', configService());
      return {};
    });

    const graph = Load(flat);

    expect(graph.nodes.map((n) => n.id)).toEqual(['config', 'shop']);
  });
});

describe('pass-through: an expose may return a boundary input directly', () => {
  const rpcContract = fakeContract({ call: async () => 'ok' });

  const rpcEnd = () =>
    dependency({
      type: 'fake/rpc',
      connection: conn({ url: { type: 'string' } }, (v) => ({ url: v.url })),
      required: rpcContract,
    });

  const rpcProvider = () =>
    service({
      name: 'provider',
      pack: 'test/pack',
      type: 'fake/compute',
      inputs: {},
      params: {},
      build,
      expose: { rpc: rpcContract },
    });

  const rpcConsumer = () =>
    service({
      name: 'sink',
      pack: 'test/pack',
      type: 'fake/compute',
      inputs: { svc: rpcEnd() },
      params: {},
      build,
    });

  // The hex provisions NOTHING with its input — it only re-offers it as its
  // own output. Re-offering is using, not ignoring (rule a).
  const passHex = () =>
    hex('pass', { deps: { svc: rpcEnd() }, expose: { svc: rpcContract } }, ({ inputs }) => ({
      svc: inputs.svc,
    }));

  test('Loads clean — returning an input as an output counts as using it', () => {
    const root = hex('shop', {}, ({ provision }) => {
      const origin = provision('origin', rpcProvider());
      const pass = provision('pass', passHex(), { svc: origin.rpc });
      provision('sink', rpcConsumer(), { svc: pass.svc });
      return {};
    });

    expect(() => Load(root)).not.toThrow();
  });

  test("a consumer wired to the pass-through output resolves to the ORIGINAL producer's real address", () => {
    const root = hex('shop', {}, ({ provision }) => {
      const origin = provision('origin', rpcProvider());
      const pass = provision('pass', passHex(), { svc: origin.rpc });
      provision('sink', rpcConsumer(), { svc: pass.svc });
      return {};
    });

    const graph = Load(root);

    // Not "pass" — the hex is transparent; the edge goes straight to origin.
    expect(graph.edges).toContainEqual({
      from: 'origin',
      to: 'sink',
      input: 'svc',
      kind: 'dependency',
    });
  });
});

describe('untyped inputs (http() escape hatch) forward with no compile-time check', () => {
  const someContract = fakeContract({ a: async () => 1 });
  const otherContract = fakeContract({ b: async () => 2 });

  test("Load's satisfies() backstop still catches a contract mismatch at the consumer", () => {
    const provider = service({
      name: 'provider',
      pack: 'test/pack',
      type: 'fake/compute',
      inputs: {},
      params: {},
      build,
      expose: { port: otherContract },
    });
    const typedConsumer = service({
      name: 'sink',
      pack: 'test/pack',
      type: 'fake/compute',
      inputs: {
        svc: dependency({
          type: 'fake/rpc',
          connection: conn({ url: { type: 'string' } }, (v) => ({ url: v.url })),
          required: someContract,
        }),
      },
      params: {},
      build,
    });

    // The hex's own input is UNTYPED — forwarding it compiles with no
    // contract check (InputRef<untyped> is `never`); the typed consumer's
    // required contract is only enforced by Load.
    const relayHex = () =>
      hex('relay', { deps: { anything: untypedEnd() } }, ({ inputs, provision }) => {
        provision('sink', typedConsumer, { svc: inputs.anything });
        return {};
      });

    const root = hex('shop', {}, ({ provision }) => {
      const p = provision('p', provider);
      provision('relay', relayHex(), { anything: p.port }); // wrong contract flows in
      return {};
    });

    expect(() => Load(root)).toThrow(LoadError);
    expect(() => Load(root)).toThrow(
      'Wiring for "relay.sink.svc" does not satisfy its required contract.',
    );
  });
});

describe('a resource-backed input now forwards across a hex boundary (unified model)', () => {
  // Under the old (pre-unification) model a ResourceEnd carried a resource
  // TYPE (a string literal), never a Contract, so InputRef mapped it to
  // `never` — a resource-backed hex input could not forward at all. In the
  // unified model every dependency slot — resource-backed or service-backed
  // — carries a Contract via `required`, so InputRef yields a real RefPort
  // for it too, and forwarding works exactly like a service-backed input.
  const dbContract = providerContract('fake/db', { url: '' });

  const dbDep = () =>
    dependency({
      name: 'db',
      type: 'fake/db',
      connection: conn({ url: { type: 'string', secret: true } }, (v) => ({ url: v.url })),
      required: dbContract,
    });

  const dbConsumer = () =>
    service({
      name: 'consumer',
      pack: 'test/pack',
      type: 'fake/compute',
      inputs: { db: dbDep() },
      params: {},
      build,
    });

  const dbHex = () =>
    hex('db-hex', { deps: { db: dbDep() } }, ({ inputs, provision }) => {
      provision('consumer', dbConsumer(), { db: inputs.db });
      return {};
    });

  const rootWithResource = () =>
    hex('shop', {}, ({ provision }) => {
      const db = provision('db', resource({ name: 'db', pack: 'test/pack', provides: dbContract }));
      provision('wrapped', dbHex(), { db });
      return {};
    });

  test('Loads clean — a hex-provisioned resource forwards through the boundary into the nested consumer', () => {
    expect(() => Load(rootWithResource())).not.toThrow();
  });

  test('the edge resolves straight to the resource — the wrapping hex is transparent', () => {
    const graph = Load(rootWithResource());

    expect(graph.edges).toContainEqual({
      from: 'db',
      to: 'wrapped.consumer',
      input: 'db',
      kind: 'dependency',
    });
  });
});

describe('provision ids may not contain "." (the address separator)', () => {
  test('a dotted id is a LoadError naming the reserved characters', () => {
    const root = hex('shop', {}, ({ provision }) => {
      provision('a.b', noOpService());
      return {};
    });

    expect(() => Load(root)).toThrow(LoadError);
    expect(() => Load(root)).toThrow(
      'provision() id "a.b" (hex "shop") may not contain "_" or "." — "_" is the config-key ' +
        'separator and "." the node-id path separator',
    );
  });
});
