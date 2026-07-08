import { hex } from '@makerkit/core';
import authService from '@storefront-auth/auth';
import storefrontService from '@storefront-auth/storefront';

/**
 * The storefront-auth app: two services in one hex. `auth` exposes an RPC
 * contract; `storefront` consumes it (auth's `rpc` port → storefront's `auth`
 * slot, compat-checked). Transparent wiring, executed at Load.
 */
export default hex('storefront-auth', (h) => {
  const authRef = h.provision('auth', authService);
  h.provision('storefront', storefrontService, { auth: authRef.rpc });
});
