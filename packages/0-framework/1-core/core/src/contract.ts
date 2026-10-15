/**
 * A Contract is the declared interface of a service-to-service dependency: a
 * protocol brand (`kind`) plus an opaque comparison type (`Cmp`) the core
 * never inspects. Wiring compatibility is plain TypeScript assignability on
 * `Cmp`, checked at `ModuleBuilder.provision`'s call site (node.ts); `satisfies`
 * is its runtime mirror, called at Load (graph.ts). Correctness comes from
 * the kind's builder shaping `Cmp` so assignability means the right thing —
 * see @prisma/composer/service-rpc's `contract()`/`rpc()`.
 */
export interface Contract<Kind extends string, Cmp> {
  readonly kind: Kind;
  readonly __cmp: Cmp;
  /** How calls over this contract communicate, when the kind guarantees one. Core only carries it onto the graph's ports. */
  readonly style?: ContractStyle;
  satisfies(required: Contract<Kind, unknown>): boolean;
}

/** The communication style a contract kind guarantees. */
export type ContractStyle = 'request-response' | 'stream';

/** The declared style of an untrusted contract value, or `undefined` when it declares none. */
export function contractStyleOf(contract: unknown): ContractStyle | undefined {
  if (typeof contract !== 'object' || contract === null || !('style' in contract)) return undefined;
  return contract.style === 'request-response' || contract.style === 'stream'
    ? contract.style
    : undefined;
}
