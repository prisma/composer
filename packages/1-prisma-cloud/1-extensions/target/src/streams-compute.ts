import type { Deps, Expose, Params } from '@internal/core';
import { blindCast } from '@internal/foundation/casts';
import { compute } from './compute.ts';

/**
 * The streams service authoring factory — a `compute` service routed to the
 * `streams` lowering instead of `compute`'s (exactly `s3StoreService` /
 * `s3-store`). It is compute's runnable (run/load/config, deps, params, build,
 * expose) with the routing `type` overridden to `'streams'`: nothing at
 * runtime keys off `type`, so only the deploy-time descriptor lookup sees the
 * override and routes to the extended-output lowering that surfaces the
 * minted bearer key on the binding. The streams module calls this with its
 * `store`/`credentials` deps and `expose: { streams: streamsContract }`.
 */
export function streamsCompute<
  D extends Deps,
  P extends Params = Record<never, never>,
  E extends Expose = Record<never, never>,
>(def: Parameters<typeof compute<D, P, E>>[0]): ReturnType<typeof compute<D, P, E>> {
  const node = compute<D, P, E>(def);
  return Object.freeze(
    blindCast<
      ReturnType<typeof compute<D, P, E>>,
      "the spread copies compute's runnable (brand, deps/params/build/expose, run/load/config) and overrides only the routing type"
    >({ ...node, type: 'streams' }),
  );
}
