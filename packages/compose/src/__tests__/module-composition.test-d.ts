import { string } from '../config.ts';
/**
 * Type-level tests for the module boundary (ADR-0016): the body's `ModuleOutputs`
 * return type checked against `expose`, `ctx.inputs`' `InputRef` brand
 * assignable wherever a `DepBindings<D>` slot is (the same check a producer's
 * ref-port gets), and that inference survives 3 levels of nesting without
 * degrading to `any`/`unknown`. Typechecked only (this package's `typecheck`
 * script) — never executed: the reject cases are structurally valid values
 * that simply fail Load's runtime backstop (see module-composition.test.ts),
 * so running this file would throw. `.test-d` (not `.test`) keeps it out of
 * `bun test`, mirroring @prisma/compose-rpc's contract-satisfaction.test-d.ts.
 */
import type { BuildAdapter, Contract, InputRef } from '../index.ts';
import { dependency, module, service } from '../index.ts';
import { conn } from './helpers.ts';

const build: BuildAdapter = {
  extension: '@prisma/compose-node',
  type: 'node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};

declare const verifyContract: Contract<
  'rpc',
  { verify(input: { token: string }): Promise<{ ok: boolean }> }
>;
declare const chargeContract: Contract<
  'rpc',
  { charge(input: { amount: number }): Promise<{ id: string }> }
>;

const verifyEnd = () =>
  dependency({
    type: 'fake/rpc-verify',
    connection: conn({ url: string() }, (v) => ({ url: v.url })),
    required: verifyContract,
  });

const chargeEnd = () =>
  dependency({
    type: 'fake/rpc-charge',
    connection: conn({ url: string() }, (v) => ({ url: v.url })),
    required: chargeContract,
  });

declare const verifyRef: { readonly __providerId: string } & typeof verifyContract;
declare const chargeRef: { readonly __providerId: string } & typeof chargeContract;

// ---- the body's return is checked against the declared `expose` ----

// MUST compile: the returned port's contract matches the declared expose key.
module('expose-ok', { expose: { verify: verifyContract } }, () => ({ verify: verifyRef }));

// @ts-expect-error the returned port is the wrong contract for "verify"
module('expose-bad', { expose: { verify: verifyContract } }, () => {
  return { verify: chargeRef };
});

// @ts-expect-error the declared "verify" key is missing from the return
module('expose-missing', { expose: { verify: verifyContract } }, () => {
  return {};
});

// ---- forwarding: ctx.inputs is a DepBindings<D>-assignable value, same as a producer's ref-port ----
//
// Under the unified model (ADR-0016) EVERY dependency slot — resource-backed
// or service-backed — is the same `DependencyEnd<C, Req>`, so there is no
// separate resource-backed type to test here: `verifyEnd`/`chargeEnd` stand
// equally for either case. (The old pre-unification ResourceEnd carried a
// resource TYPE, not a Contract, so InputRef mapped it to `never` and
// resource-backed forwarding could not compile at all — see
// module-composition.test.ts's runtime proof that a real module-provisioned
// resource now forwards through a boundary exactly like this.)

const chargeConsumer = service({
  name: 'consumer',
  extension: 'test/pack',
  type: 'fake/compute',
  inputs: { pay: chargeEnd() },
  params: {},
  build,
});

// MUST compile: forwarding a same-contract input into a matching slot.
module('forward-ok', { deps: { pay: chargeEnd() } }, ({ inputs, provision }) => {
  provision(chargeConsumer, { id: 'consumer', deps: { pay: inputs.pay } });
  return {};
});

// MUST be rejected: forwarding a wrong-contract input into a typed slot.
module('forward-bad', { deps: { verify: verifyEnd() } }, ({ inputs, provision }) => {
  // @ts-expect-error inputs.verify carries verifyContract, not the chargeContract "pay" requires
  provision(chargeConsumer, { id: 'consumer', deps: { pay: inputs.verify } });
  return {};
});

// ---- untyped inputs (http()'s escape hatch): no compile-time forwarding check ----

// Req = unknown — `unknown` does not extend Contract, so InputRef resolves to
// `never`: the forwarded value carries NO compile-time contract, and any slot
// accepts it. This pins current behavior; correctness for untyped inputs
// rests entirely on Load's satisfies() backstop at the consumer (see
// module-composition.test.ts's "untyped inputs" runtime test).
const untypedEnd = () =>
  dependency({
    type: 'fake/http',
    connection: conn({ url: string() }, (v) => ({ url: v.url })),
  });

type UntypedInput = InputRef<ReturnType<typeof untypedEnd>>;
const untypedInputIsNever: [UntypedInput] extends [never] ? true : false = true;
void untypedInputIsNever;

// MUST compile: an untyped input forwards into ANY slot — typed or untyped —
// with no compile-time rejection possible.
module('untyped-forward', { deps: { anything: untypedEnd() } }, ({ inputs, provision }) => {
  provision(chargeConsumer, { id: 'typed', deps: { pay: inputs.anything } });
  return {};
});

// ---- 3-level nesting: inference must survive, in both directions ----

const verifyProvider = () =>
  service({
    name: 'provider',
    extension: 'test/pack',
    type: 'fake/compute',
    inputs: {},
    params: {},
    build,
    expose: { verify: verifyContract },
  });

const verifyConsumer = () =>
  service({
    name: 'sink',
    extension: 'test/pack',
    type: 'fake/compute',
    inputs: { verify: verifyEnd() },
    params: {},
    build,
  });

// depth 2 (leaf): forwards its own declared input straight into a service,
// and re-exposes that service's port — no explicit type args anywhere.
const innerModule = module(
  'inner',
  { deps: { verify: verifyEnd() }, expose: { verify: verifyContract } },
  ({ inputs, provision }) => {
    const leaf = provision(verifyConsumer(), { id: 'leaf', deps: { verify: inputs.verify } });
    // leaf has no expose — prove `leaf.id` (the wholesale ref) is still usable at this depth.
    void leaf.id;
    const producer = provision(verifyProvider(), { id: 'leafProvider' });
    return { verify: producer.verify };
  },
);

// depth 1: the same pass-through pattern, wrapping `innerModule`.
const midModule = module(
  'mid',
  { deps: { verify: verifyEnd() }, expose: { verify: verifyContract } },
  ({ inputs, provision }) => {
    const inner = provision(innerModule, { id: 'inner', deps: { verify: inputs.verify } });
    return { verify: inner.verify };
  },
);

// root: wires a real producer's port down through 2 boundaries of `midModule`,
// then wires `mid`'s (forwarded-up) output into a plain service — MUST
// compile with no casts, proving the 3-level chain infers end to end.
module('root-ok', {}, ({ provision }) => {
  const p = provision(verifyProvider(), { id: 'provider' });
  const mid = provision(midModule, { id: 'mid', deps: { verify: p.verify } });
  provision(verifyConsumer(), { id: 'sink', deps: { verify: mid.verify } });
  return {};
});

// The same chain, but the final wiring requires the WRONG contract — MUST
// still be rejected at depth 3, proving the inferred type at the far end of
// the chain is precise (not widened to `unknown`/`any` by the 2 hops).
module('root-bad', {}, ({ provision }) => {
  const p = provision(verifyProvider(), { id: 'providerX' });
  const mid = provision(midModule, { id: 'midX', deps: { verify: p.verify } });
  // @ts-expect-error mid.verify carries verifyContract; chargeConsumer's "pay" requires chargeContract
  provision(chargeConsumer, { id: 'consumerX', deps: { pay: mid.verify } });
  return {};
});

// ---- id-less provision(): id inferred from node.name, ref type unchanged ----

// MUST compile: the inferred form returns the same ProvisionedRef as the
// explicit form — the exposed port survives, and both the service+wiring and
// module+wiring id-less overloads contract-check their wiring.
module('inferred-ok', {}, ({ provision }) => {
  const provider = provision(verifyProvider());
  const mid = provision(midModule, { deps: { verify: provider.verify } });
  provision(verifyConsumer(), { deps: { verify: mid.verify } });
  return {};
});

// MUST be rejected: the id-less form still contract-checks the wiring.
module('inferred-bad', {}, ({ provision }) => {
  const provider = provision(verifyProvider());
  // @ts-expect-error provider.verify carries verifyContract; chargeConsumer's "pay" requires chargeContract
  provision(chargeConsumer, { deps: { pay: provider.verify } });
  return {};
});

// Closed-root overload: no boundary argument, no return. `ctx` still carries
// `provision`, and `inputs` is empty — the body needs nothing else. (The
// id-defaulted ok/reject cases are already covered by inferred-ok/inferred-bad
// above, which also exercise module-node inference.)
module('closed-root', ({ provision }) => {
  provision(verifyProvider(), { id: 'provider' });
});
