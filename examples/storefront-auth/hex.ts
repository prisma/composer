import { type HexBuilder, hex } from '@makerkit/core';
import authService from './hexes/auth/src/service.ts';
import storefrontService from './hexes/storefront/src/service.ts';

/**
 * The storefront-auth app: two services in one hex. `auth` exposes an RPC
 * contract; `storefront` consumes it (auth's `rpc` port → storefront's `auth`
 * slot, compat-checked). Transparent wiring, executed at Load.
 */
export default hex('storefront-auth', (h: HexBuilder) => {
  const authRef = h.provision('auth', authService);
  h.provision('storefront', storefrontService, { auth: authRef.rpc });
});
