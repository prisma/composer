// Feasibility proof for wiring the compat check into the actual hex:
//   - rpc(contract) connection-end carries its REQUIRED contract (2nd type param)
//   - http() is untyped (Req = unknown) — the escape hatch
//   - ProvisionedRef carries the provider's `expose` as ref-ports (id + contract)
//   - provision(consumer, wiring) checks each wired ref-port satisfies its slot
// Self-checking via @ts-expect-error. Compile with --strict.

// ===== CORE =====
interface Contract<Kind extends string, Cmp> {
  readonly kind: Kind
  readonly __cmp: Cmp
  satisfies(required: Contract<Kind, unknown>): boolean
}
// A dependency end: hydrated client C + its required contract Req (unknown = untyped).
interface ConnectionEnd<C, Req = unknown> {
  readonly __client: C
  readonly __req: Req
}
// biome-ignore lint: poc
type Expose = Record<string, Contract<any, any>>
// biome-ignore lint: poc
type Deps = Record<string, ConnectionEnd<any, any>>
interface ServiceNode<D extends Deps, E extends Expose = Record<never, never>> {
  readonly inputs: D
  readonly expose?: E
}

// A ref-port: the provider's exposed contract, plus which provider (runtime id).
// Intersecting with the id keeps it assignable to the bare contract, so the
// compat check is unchanged.
// biome-ignore lint: poc
type RefPort<C extends Contract<any, any>> = C & { readonly __providerId: string }
type ProvisionedRef<E extends Expose> = { readonly [P in keyof E]: RefPort<E[P]> }

// Pull the required contract out of a dep (unknown for an untyped http() slot).
type ReqOf<CE> = CE extends ConnectionEnd<any, infer Req> ? Req : never

// provision(id, service) -> a ref carrying its exposed ports.
declare function provision<E extends Expose>(id: string, service: ServiceNode<Deps, E>): ProvisionedRef<E>
// provision(id, consumer, wiring): each dep's wired value must be assignable to its
// required contract. Untyped deps have Req = unknown -> accept anything (escape hatch).
declare function provision<D extends Deps>(
  id: string,
  consumer: ServiceNode<D, Expose>,
  wiring: { [K in keyof D]: NoInfer<ReqOf<D[K]>> },
): void

// ===== RPC KIND (concrete function-map Cmp, as proven) =====
interface Schema<T> { readonly _t: T }
declare function type<T>(): Schema<T>
declare function rpc<I, O>(m: { input: Schema<I>; output: Schema<O> }): (input: I) => Promise<O>
// biome-ignore lint: poc
declare function contract<Fns extends Record<string, (i: any) => Promise<any>>>(fns: Fns): Contract<'rpc', Fns>
type Client<C> = C extends Contract<string, infer Cmp> ? Cmp : never
// rpc(contract) connection-end: carries Client + the required contract.
declare function rpcDep<C extends Contract<'rpc', unknown>>(c: C): ConnectionEnd<Client<C>, C>
// http(): untyped connection-end (the escape hatch).
declare function http(): ConnectionEnd<{ url: string }, unknown>

// ===== APP =====
const authContract = contract({
  verify: rpc({ input: type<{ token: string }>(), output: type<{ ok: boolean }>() }),
})
// a different, incompatible contract
const paymentsContract = contract({
  charge: rpc({ input: type<{ amount: number }>(), output: type<{ id: string }>() }),
})
// a provider exposing an auth contract that demands an EXTRA input
const extraInputAuth = contract({
  verify: rpc({ input: type<{ token: string; tenant: string }>(), output: type<{ ok: boolean }>() }),
})

declare const authSvc: ServiceNode<Record<never, never>, { rpc: typeof authContract }>
declare const paymentsSvc: ServiceNode<Record<never, never>, { rpc: typeof paymentsContract }>
declare const badAuthSvc: ServiceNode<Record<never, never>, { rpc: typeof extraInputAuth }>

// consumer requiring auth (typed) + a legacy untyped http dep
declare const storefront: ServiceNode<{
  auth: ConnectionEnd<Client<typeof authContract>, typeof authContract>
  legacy: ReturnType<typeof http>
}>

const authRef = provision('auth', authSvc)
const paymentsRef = provision('payments', paymentsSvc)
const badRef = provision('bad', badAuthSvc)

// ---- MUST compile: the right provider into the auth slot; anything into the untyped legacy slot ----
provision('storefront', storefront, { auth: authRef.rpc, legacy: paymentsRef.rpc })

// ---- MUST be rejected ----
// @ts-expect-error wrong provider (payments) into the auth slot
provision('storefront', storefront, { auth: paymentsRef.rpc, legacy: authRef.rpc })
// @ts-expect-error provider whose contract requires an extra input (contravariant)
provision('storefront', storefront, { auth: badRef.rpc, legacy: authRef.rpc })
// @ts-expect-error the ref exposes no such port
provision('storefront', storefront, { auth: authRef.nope, legacy: authRef.rpc })
