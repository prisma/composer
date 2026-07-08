/**
 * The accept/reject matrix for contract compatibility, checked on the real
 * hex: `HexBuilder.provision` wiring a ref-port into a consumer's
 * `rpc(contract)` slot, using this package's real
 * `contract()`/`rpc()`. Typechecked only (the package's `typecheck` script) —
 * never executed: the reject cases are structurally valid providers that
 * simply fail Load's nominal `satisfies()` check (see rpc-connection.test.ts
 * and @makerkit/core's hex.test.ts), so running this file would throw.
 * `.test-d` (not `.test`) keeps it out of `bun test`.
 */
import type { BuildAdapter, Contract, HexBuilder } from '@makerkit/core';
import { connectionEnd, service } from '@makerkit/core';
import { type } from 'arktype';
import { contract } from '../contract.ts';
import { type Client, rpc } from '../rpc.ts';

const build: BuildAdapter = { kind: 'node', entry: 'server.js' };

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

// a second protocol kind, standing in for one @makerkit/rpc knows nothing
// about — only to prove cross-protocol wiring is rejected by the brand.
declare function wsContract<
  // biome-ignore lint/suspicious/noExplicitAny: mirrors contract-satisfaction.poc.ts's `wsContract` stub.
  Fns extends Record<string, (input: any) => Promise<any>>,
>(fns: Fns): Contract<'ws', Fns>;
const wrongKind = wsContract({
  verify: rpc({ input: type({ token: 'string' }), output: type({ ok: 'boolean' }) }),
});

// an untyped connection end — http()'s shape (Req = unknown, the escape hatch).
const legacyEnd = () =>
  connectionEnd({
    type: 'fake/http',
    connection: { params: { url: { type: 'string' } }, hydrate: (v: { url: string }) => v },
  });

const provider = <C extends Contract<string, unknown>>(exposed: C) =>
  service({ type: 'fake/compute', inputs: {}, params: {}, build, expose: { auth: exposed } });

const storefront = service({
  type: 'fake/compute',
  inputs: { auth: rpc(authContract), legacy: legacyEnd() },
  params: {},
  build,
});

declare const h: HexBuilder;

const exactRef = h.provision('s1', provider(exact));
const extraOutRef = h.provision('s2', provider(extraOut));
const extraMethodRef = h.provision('s3', provider(extraMethod));
const extraInputRef = h.provision('s4', provider(extraInput));
const missingRef = h.provision('s5', provider(missing));
const wrongKindRef = h.provision('s6', provider(wrongKind));

// ---- MUST compile ----
h.provision('c1', storefront, { auth: exactRef.auth, legacy: exactRef.auth });
h.provision('c2', storefront, { auth: extraOutRef.auth, legacy: exactRef.auth }); // covariant output
h.provision('c3', storefront, { auth: extraMethodRef.auth, legacy: exactRef.auth }); // width
h.provision('c4', storefront, { auth: exactRef.auth, legacy: missingRef.auth }); // untyped slot: anything

// ---- MUST be rejected ----
// @ts-expect-error provider requires an extra input the consumer never sends (contravariant)
h.provision('c5', storefront, { auth: extraInputRef.auth, legacy: exactRef.auth });
// @ts-expect-error provider is missing the required method
h.provision('c6', storefront, { auth: missingRef.auth, legacy: exactRef.auth });
// @ts-expect-error different protocol kind
h.provision('c7', storefront, { auth: wrongKindRef.auth, legacy: exactRef.auth });
// @ts-expect-error the ref exposes no such port
h.provision('c8', storefront, { auth: exactRef.nope, legacy: exactRef.auth });

// ---- and the derived client is typed both ways ----
export async function clientUsage() {
  const auth = null as unknown as Client<typeof authContract>;
  const r = await auth.verify({ token: 't' });
  const ok: boolean = r.ok;
  // @ts-expect-error unknown method
  auth.nope();
  // @ts-expect-error wrong input shape (token must be a string)
  await auth.verify({ token: 123 });
  return ok;
}
