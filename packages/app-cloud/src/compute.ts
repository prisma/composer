import type { BuildAdapter, Deps, Expose, Loaded, RunnableServiceNode } from '@prisma/app';
import { configOf, hydrateSync, service } from '@prisma/app';
import { blindCast } from '@prisma/app/casts';
import { deserialize, stash } from './serializer.ts';

const computeParams = { port: { type: 'number', default: 3000 } } as const;

/**
 * A Prisma Compute service — declarations only (deps + build + the ports it
 * exposes), no handler. Returns the extension's runnable/loadable node:
 *   · run(address, boot) — the process controller: deserialize the platform
 *     environment (keyed off `address`, the extension's ONE env read) into a
 *     typed Config, re-emit it under address-free process-local stash keys,
 *     then call boot() to start the app's entry.
 *   · load() — called from inside the app's entry: read the stash, hydrate the
 *     deps synchronously, memoize per process, return them merged with the
 *     resolved service params (typed).
 *
 * `service()`'s underlying node carries `extension: '@prisma/app-cloud'` —
 * the control-plane registry key `prisma-app deploy` resolves through the
 * app's `prisma-app.config.ts` (ADR-0017). This module loads nothing at
 * deploy time; nodes are pure data.
 */
export const compute = <D extends Deps, E extends Expose = Record<never, never>>(def: {
  name: string;
  deps: D;
  build: BuildAdapter;
  expose?: E;
}): RunnableServiceNode<D, typeof computeParams, E> => {
  // load() merges deps and service params into one object; a dep whose name
  // collides with a service param would be silently clobbered. Fail at
  // authoring instead.
  for (const reserved of Object.keys(computeParams)) {
    if (reserved in def.deps) {
      throw new Error(
        `compute(): dependency "${reserved}" collides with the reserved service param of the same name — rename the dependency.`,
      );
    }
  }
  const node = service<D, typeof computeParams, E>({
    name: def.name,
    extension: '@prisma/app-cloud',
    type: 'compute',
    inputs: def.deps,
    params: computeParams,
    build: def.build,
    ...(def.expose !== undefined ? { expose: def.expose } : {}),
  });

  let loaded: Loaded<D, typeof computeParams> | undefined;

  const runnable = {
    ...node,
    async run(address: string, boot: () => Promise<unknown>) {
      const shape = configOf(node);
      stash(shape, deserialize(shape, address));
      return boot();
    },
    load() {
      if (loaded === undefined) {
        const shape = configOf(node);
        const config = deserialize(shape, '');
        loaded = blindCast<
          Loaded<D, typeof computeParams>,
          'merges hydrated deps with the deserialized service config record (untyped at runtime) into the typed Loaded shape'
        >({ ...hydrateSync(node, config), ...config.service });
      }
      return loaded;
    },
  };
  return Object.freeze(
    blindCast<
      RunnableServiceNode<D, typeof computeParams, E>,
      "the spread copies node's own enumerable data (including the Symbol.for brand) and adds run/load — exactly RunnableServiceNode's shape"
    >(runnable),
  );
};
