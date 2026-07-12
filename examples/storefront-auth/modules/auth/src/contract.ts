/**
 * The auth service's public RPC contract — it lives with the service that owns it.
 * auth exposes and serves it (service.ts / server.ts); a consumer imports it and
 * depends on it via `rpc(authContract)`, getting back a typed client.
 */
import { contract, rpc } from '@prisma/compose/rpc';
import { type } from 'arktype';

export const authContract = contract({
  verify: rpc({ input: type({ token: 'string' }), output: type({ ok: 'boolean' }) }),
});
