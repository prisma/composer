import type { BuildAdapter, Deps, Loaded, RunnableServiceNode } from '@makerkit/core';
import { configOf, hydrateSync, service } from '@makerkit/core';
import { deserialize, stash } from './serializer.ts';

const computeParams = { port: { type: 'number', default: 3000 } } as const;

/**
 * A Prisma Compute service — declarations only (deps + build), no handler.
 * Returns the pack's runnable/loadable node:
 *   · run(address, boot) — the process controller: deserialize the platform
 *     environment (keyed off `address`, the pack's ONE env read) into a typed
 *     Config, re-emit it under address-free process-local stash keys, then call
 *     boot() to start the app's entry.
 *   · load() — called from inside the app's entry: read the stash, hydrate the
 *     deps synchronously, memoize per process, return them merged with the
 *     resolved service params (typed).
 */
export const compute = <D extends Deps>(def: {
  deps: D;
  build: BuildAdapter;
}): RunnableServiceNode<D, typeof computeParams> => {
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
  const node = service({
    type: 'prisma-cloud/compute',
    inputs: def.deps,
    params: computeParams,
    build: def.build,
  });

  let loaded: Loaded<D, typeof computeParams> | undefined;

  return Object.freeze({
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
        loaded = { ...hydrateSync(node, config), ...config.service } as Loaded<
          D,
          typeof computeParams
        >;
      }
      return loaded;
    },
  }) as RunnableServiceNode<D, typeof computeParams>;
};
