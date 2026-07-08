/**
 * The auth service's RPC contract — shared by both hexes. `auth` exposes and
 * serves it (server.ts); `storefront` depends on it via `rpc(authContract)`
 * and gets back a typed client (service.ts, page.tsx).
 */
import { contract, rpc } from '@makerkit/rpc';
import { type } from 'arktype';

export const authContract = contract({
  verify: rpc({ input: type({ token: 'string' }), output: type({ ok: 'boolean' }) }),
});
