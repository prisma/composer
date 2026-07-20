/**
 * Wire-protocol constants shared by the client (`client.ts`) and the server
 * (`serve.ts`) — kept in one file so the two sides can't drift on the header
 * name.
 */

/**
 * Every RPC request carries this header: a UUID minted once per logical
 * call and reused byte-identically across every retry of that call. `serve()`
 * rejects a request that omits it.
 */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
