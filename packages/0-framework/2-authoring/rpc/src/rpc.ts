/**
 * `rpc()` is the RPC kind's single entry, overloaded by what it's given. A
 * `{ input, output }` pair types one contract method as a concrete
 * `(input) => Promise<output>` — the shape that makes Contract's plain
 * assignability apply real function variance. Input/output are Standard
 * Schema validators (arktype the canonical one); the runtime value carries
 * the two schemas for serve()/the client to read back out.
 *
 * A Contract instead types a dependency end — the typed sibling
 * of `http()`, same `{ url }` param plus an optional `serviceKey` (the
 * per-binding auth token ADR-0030 wires through here as a provisioning need,
 * ADR-0031), hydrating to the typed client `Client<C>` over the network
 * binding in client.ts. It carries the contract as its `required` value, so
 * `ModuleBuilder.provision`'s wiring is checked against it (compile time) and
 * Load's `satisfies()` backstop re-checks it (runtime).
 */
import type { Contract, ProvisionNeed } from '@internal/core';
import { type DependencyEnd, dependency, provisionNeed, string } from '@internal/core';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { makeClient } from './client.ts';

/** ADR-0031's need brand for RPC's per-binding service key — the target registers a provisioner under this. */
export const RPC_PEER_KEY: unique symbol = Symbol.for('prisma:rpc/per-binding-key');

/** The provisioning need `rpc()`'s `serviceKey` param declares (ADR-0030): a shared, unguessable value the target mints per consumer edge. */
export const perBindingToken = (): ProvisionNeed => provisionNeed(RPC_PEER_KEY);

/** The concrete function-map bound every RPC Contract's Cmp must fit. */
// biome-ignore lint/suspicious/noExplicitAny: concrete function-map bound, matches contract()'s own (see contract.ts).
export type RpcFns = Record<string, (input: any) => Promise<any>>;

export function rpc<I extends StandardSchemaV1, O extends StandardSchemaV1>(m: {
  input: I;
  output: O;
}): (input: StandardSchemaV1.InferInput<I>) => Promise<StandardSchemaV1.InferOutput<O>>;
export function rpc<C extends Contract<'rpc', RpcFns>>(contract: C): DependencyEnd<Client<C>, C>;
export function rpc(
  arg: { input: StandardSchemaV1; output: StandardSchemaV1 } | Contract<'rpc', RpcFns>,
): unknown {
  if (!isRpcContract(arg)) return arg;

  return dependency({
    type: 'rpc',
    connection: {
      params: {
        url: string(),
        serviceKey: string({ optional: true, provision: perBindingToken() }),
      },
      hydrate: ({ url, serviceKey }) => makeClient(arg, url, { serviceKey }),
    },
    required: arg,
  });
}

function isRpcContract(value: unknown): value is Contract<'rpc', RpcFns> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    value.kind === 'rpc' &&
    '__cmp' in value &&
    'satisfies' in value
  );
}

/** The typed client a consumer's `rpc(contract)` dependency hydrates to. */
export type Client<C> = C extends Contract<string, infer Cmp> ? Cmp : never;
