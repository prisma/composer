import { module } from '@prisma/composer';
import { envSecret } from '@prisma/composer-prisma-cloud';
import authModule from '@storefront-auth/auth';
import storefrontService from '@storefront-auth/storefront';

/**
 * The storefront-auth app: the reusable auth Module (owns its own Postgres)
 * and the storefront service, composed in one root. The root provisions
 * nothing of auth's internals — it wires auth's exposed `rpc` port into
 * storefront's `auth` slot exactly as it would for any other producer of
 * that contract.
 */
export default module('storefront-auth', ({ provision }) => {
  // The root binds the auth module's signingKey to the platform variable
  // AUTH_SIGNING_SECRET; preflight fills it from the secrets pool when missing.
  const auth = provision(authModule, {
    input: { signingKey: envSecret('AUTH_SIGNING_SECRET') },
  });
  provision(storefrontService, { deps: { auth: auth.rpc } });
});
