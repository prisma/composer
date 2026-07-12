import { system } from '@prisma/app';
import authSystem from '@storefront-auth/auth';
import storefrontService from '@storefront-auth/storefront';

/**
 * The storefront-auth app: the reusable auth System (owns its own Postgres)
 * and the storefront service, composed in one root. The root provisions
 * nothing of auth's internals — it wires auth's exposed `rpc` port into
 * storefront's `auth` slot exactly as it would for any other producer of
 * that contract.
 */
export default system('storefront-auth', ({ provision }) => {
  const auth = provision(authSystem);
  provision(storefrontService, { auth: auth.rpc });
});
