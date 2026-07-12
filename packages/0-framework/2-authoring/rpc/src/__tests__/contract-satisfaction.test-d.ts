/**
 * The accept/reject matrix for contract compatibility, checked on the real
 * module: `ModuleBuilder.provision` wiring a ref-port into a consumer's
 * `rpc(contract)` slot, using this package's real `contract()`/`rpc()`.
 *
 * Type-only (vitest `--typecheck`, never executed): the reject cases are
 * structurally valid providers that simply fail Load's nominal `satisfies()`
 * check (see rpc-connection.test.ts and @prisma/compose's module.test.ts), so
 * running the calls would throw. Positive cases use `expectTypeOf` matchers;
 * the negative wirings keep a `// @ts-expect-error` on the offending line.
 */
import type { BuildAdapter, Contract, ModuleBuilder } from '@internal/core';
import { dependency, service, string } from '@internal/core';
import { type } from 'arktype';
import { expectTypeOf, test } from 'vitest';
import { contract } from '../contract.ts';
import { type Client, rpc } from '../rpc.ts';

const build: BuildAdapter = {
  extension: '@prisma/compose/node',
  type: 'node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};

const authContract = contract({
  verify: rpc({ input: type({ token: 'string' }), output: type({ ok: 'boolean' }) }),
});

// candidate providers (standing in for provisioned refs' exposed contracts)
const exact = contract({
  verify: rpc({ input: type({ token: 'string' }), output: type({ ok: 'boolean' }) }),
});
const extraOut = contract({
  verify: rpc({
    input: type({ token: 'string' }),
    output: type({ ok: 'boolean', user: 'string' }),
  }),
});
const extraMethod = contract({
  verify: rpc({ input: type({ token: 'string' }), output: type({ ok: 'boolean' }) }),
  refresh: rpc({ input: type({ rt: 'string' }), output: type({ token: 'string' }) }),
});
const extraInput = contract({
  verify: rpc({
    input: type({ token: 'string', tenant: 'string' }),
    output: type({ ok: 'boolean' }),
  }),
});
const missing = contract({
  whoami: rpc({ input: type({}), output: type({ id: 'string' }) }),
});

// a second protocol kind, standing in for one @prisma/compose/rpc knows nothing
// about — only to prove cross-protocol wiring is rejected by the brand.
declare function wsContract<
  // biome-ignore lint/suspicious/noExplicitAny: mirrors contract-satisfaction.poc.ts's `wsContract` stub.
  Fns extends Record<string, (input: any) => Promise<any>>,
>(fns: Fns): Contract<'ws', Fns>;
const wrongKind = wsContract({
  verify: rpc({ input: type({ token: 'string' }), output: type({ ok: 'boolean' }) }),
});

// an untyped dependency end — http()'s shape (Req = unknown, the escape hatch).
const legacyEnd = () =>
  dependency({
    type: 'fake/http',
    connection: { params: { url: string() }, hydrate: (v: { url: string }) => v },
  });

const provider = <C extends Contract<string, unknown>>(exposed: C) =>
  service({
    name: 'test-service',
    extension: 'test/pack',
    type: 'fake/compute',
    inputs: {},
    params: {},
    build,
    expose: { auth: exposed },
  });

const storefront = service({
  name: 'test-service',
  extension: 'test/pack',
  type: 'fake/compute',
  inputs: { auth: rpc(authContract), legacy: legacyEnd() },
  params: {},
  build,
});

declare const h: ModuleBuilder;

const exactRef = h.provision(provider(exact), { id: 's1' });
const extraOutRef = h.provision(provider(extraOut), { id: 's2' });
const extraMethodRef = h.provision(provider(extraMethod), { id: 's3' });
const extraInputRef = h.provision(provider(extraInput), { id: 's4' });
const missingRef = h.provision(provider(missing), { id: 's5' });
const wrongKindRef = h.provision(provider(wrongKind), { id: 's6' });

test('a satisfying (or wider) ref-port fills the required rpc slot', () => {
  expectTypeOf(h.provision).toBeCallableWith(storefront, {
    id: 'c1',
    deps: {
      auth: exactRef.auth,
      legacy: exactRef.auth,
    },
  });
  // covariant output
  expectTypeOf(h.provision).toBeCallableWith(storefront, {
    id: 'c2',
    deps: {
      auth: extraOutRef.auth,
      legacy: exactRef.auth,
    },
  });
  // width
  expectTypeOf(h.provision).toBeCallableWith(storefront, {
    id: 'c3',
    deps: {
      auth: extraMethodRef.auth,
      legacy: exactRef.auth,
    },
  });
  // untyped slot: anything
  expectTypeOf(h.provision).toBeCallableWith(storefront, {
    id: 'c4',
    deps: {
      auth: exactRef.auth,
      legacy: missingRef.auth,
    },
  });
});

test('an incompatible ref-port for a required rpc slot does not compile', () => {
  // @ts-expect-error provider requires an extra input the consumer never sends (contravariant)
  h.provision(storefront, { id: 'c5', deps: { auth: extraInputRef.auth, legacy: exactRef.auth } });
  // @ts-expect-error provider is missing the required method
  h.provision(storefront, { id: 'c6', deps: { auth: missingRef.auth, legacy: exactRef.auth } });
  // @ts-expect-error different protocol kind
  h.provision(storefront, { id: 'c7', deps: { auth: wrongKindRef.auth, legacy: exactRef.auth } });
  // @ts-expect-error the ref exposes no such port
  h.provision(storefront, { id: 'c8', deps: { auth: exactRef.nope, legacy: exactRef.auth } });
});

test('the derived client is typed both ways', () => {
  const auth = null as unknown as Client<typeof authContract>;
  expectTypeOf(auth.verify).toBeCallableWith({ token: 't' });
  expectTypeOf(auth.verify({ token: 't' })).resolves.toExtend<{ ok: boolean }>();
  // @ts-expect-error unknown method
  auth.nope();
  // @ts-expect-error wrong input shape (token must be a string)
  auth.verify({ token: 123 });
});
