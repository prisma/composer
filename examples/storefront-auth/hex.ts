import { hex } from '@makerkit/core';
import { postgres } from '@makerkit/prisma-cloud';
import authService from '@storefront-auth/auth';
import storefrontService from '@storefront-auth/storefront';

/**
 * The storefront-auth app: two services and their shared Postgres in one hex.
 * The hex owns the database and wires it into auth's `db` slot; `auth` exposes
 * an RPC contract; `storefront` consumes it (auth's `rpc` port → storefront's
 * `auth` slot, compat-checked). Transparent wiring, executed at Load.
 *
 * The provision id is `database`, not `db`: the prisma-cloud target passes it
 * through as the Prisma resource name, and the Connection API rejects names
 * shorter than 3 characters. The wiring key stays `db` (auth's input name), so
 * the deployed env key is still `AUTH_DB_URL` — it derives from the input
 * name, not the provision id.
 */
export default hex('storefront-auth', (h) => {
  const db = h.provision('database', postgres({ name: 'database' }));
  const authRef = h.provision('auth', authService, { db });
  h.provision('storefront', storefrontService, { auth: authRef.rpc });
});
