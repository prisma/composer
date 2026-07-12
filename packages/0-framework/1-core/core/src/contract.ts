/**
 * A Contract is the declared interface of a service-to-service dependency: a
 * protocol brand (`kind`) plus an opaque comparison type (`Cmp`) the core
 * never inspects. Wiring compatibility is plain TypeScript assignability on
 * `Cmp`, checked at `ModuleBuilder.provision`'s call site (node.ts); `satisfies`
 * is its runtime mirror, called at Load (graph.ts). Correctness comes from
 * the kind's builder shaping `Cmp` so assignability means the right thing —
 * see @prisma/compose/rpc's `contract()`/`rpc()`.
 */
export interface Contract<Kind extends string, Cmp> {
  readonly kind: Kind;
  readonly __cmp: Cmp;
  satisfies(required: Contract<Kind, unknown>): boolean;
}
