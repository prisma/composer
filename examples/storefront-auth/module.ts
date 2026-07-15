import { module } from '@prisma/compose';
import { envSecret } from '@prisma/compose-prisma-cloud';
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
  // The ROOT binds the auth module's secret need to the platform env var
  // AUTH_SIGNING_SECRET (ADR-0029); preflight fill-missing provisions it from
  // the deploy shell (the CI runner env).
  const auth = provision(authModule, {
    secrets: { signingKey: envSecret('AUTH_SIGNING_SECRET') },
  });
  provision(storefrontService, { deps: { auth: auth.rpc } });
});
