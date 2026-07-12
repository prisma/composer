/**
 * The RPC kind: `contract()` + `rpc()` build a Contract whose Cmp is a
 * concrete function map; `rpc(contract)` (the connection-end overload)
 * hydrates a consumer's dependency to `Client<C>` over the network binding in
 * client.ts; `serve()` generates a provider's fetch handler straight off a
 * service's `expose`. All web-standard (fetch/Request/Response) — runs
 * anywhere those exist, no node/bun coupling.
 */

export type { Transport } from './client.ts';
export { makeClient } from './client.ts';
export { contract } from './contract.ts';
export type { Client } from './rpc.ts';
export { rpc } from './rpc.ts';
export type { Handlers } from './serve.ts';
export { serve } from './serve.ts';
