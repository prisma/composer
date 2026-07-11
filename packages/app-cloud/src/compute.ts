import type {
  BuildAdapter,
  Config,
  Deps,
  Expose,
  HydratedDeps,
  Params,
  RunnableServiceNode,
  Values,
} from '@prisma/app';
import { hydrateSync, number, service } from '@prisma/app';
import { blindCast } from '@prisma/app/casts';
import { deserialize, stash } from './serializer.ts';

const reservedParams = { port: number({ default: 3000 }) } as const;
type ReservedParams = typeof reservedParams;

/**
 * A Prisma Compute service — declarations only (deps + params + build + the
 * ports it exposes), no handler. `params` merges with the reserved
 * `ReservedParams` (`port`); a user param whose name collides with a reserved
 * one fails at authoring, the same way a colliding dependency name does.
 * Returns the extension's runnable/loadable node:
 *   · run(address, boot) — the process controller: deserialize the platform
 *     environment (keyed off `address`, the extension's ONE env read) into a
 *     typed Config, re-emit it under address-free process-local stash keys,
 *     then call boot() to start the app's entry.
 *   · load() / config() — called from inside the app's entry: read the stash;
 *     load() hydrates + memoizes the deps, config() returns the typed params.
 *     Separate accessors so a dep and a param never share a namespace (ADR-0021).
 *
 * `service()`'s underlying node carries `extension: '@prisma/app-cloud'` —
 * the control-plane registry key `prisma-app deploy` resolves through the
 * app's `prisma-app.config.ts` (ADR-0017). This module loads nothing at
 * deploy time; nodes are pure data.
 */
export const compute = <
  D extends Deps,
  P extends Params = Record<never, never>,
  E extends Expose = Record<never, never>,
>(def: {
  name: string;
  deps: D;
  params?: P;
  build: BuildAdapter;
  expose?: E;
}): RunnableServiceNode<D, P & ReservedParams, E> => {
  const userParams = def.params ?? blindCast<P, 'no user params supplied'>({});

  // load() merges deps and service params into one object; a dep or a user
  // param whose name collides with a reserved param would be silently
  // clobbered. Fail at authoring instead.
  for (const reserved of Object.keys(reservedParams)) {
    if (reserved in def.deps) {
      throw new Error(
        `compute(): dependency "${reserved}" collides with the reserved service param of the same name — rename the dependency.`,
      );
    }
    if (reserved in userParams) {
      throw new Error(
        `compute(): param "${reserved}" collides with the reserved service param of the same name — rename the param.`,
      );
    }
  }

  const params = blindCast<P & ReservedParams, 'reserved params merged over user params'>({
    ...userParams,
    ...reservedParams,
  });
  const node = service<D, P & ReservedParams, E>({
    name: def.name,
    extension: '@prisma/app-cloud',
    type: 'compute',
    inputs: def.deps,
    params,
    build: def.build,
    ...(def.expose !== undefined ? { expose: def.expose } : {}),
  });

  // load() and config() share one deserialize of the process-local stash.
  let resolved: Config | undefined;
  let loadedDeps: HydratedDeps<D> | undefined;
  let loadedParams: Values<P & ReservedParams> | undefined;
  function processConfig(): Config {
    if (resolved === undefined) resolved = deserialize(node, '');
    return resolved;
  }

  const runnable = {
    ...node,
    async run(address: string, boot: () => Promise<unknown>) {
      stash(node, deserialize(node, address));
      return boot();
    },
    load() {
      if (loadedDeps === undefined) {
        loadedDeps = blindCast<
          HydratedDeps<D>,
          'hydrateSync returns HydratedDeps<Deps>; for this node the deps are D'
        >(hydrateSync(node, processConfig()));
      }
      return loadedDeps;
    },
    config() {
      if (loadedParams === undefined) {
        loadedParams = blindCast<
          Values<P & ReservedParams>,
          'the deserialized service config record (untyped at runtime) is exactly the typed Values shape'
        >(processConfig().service);
      }
      return loadedParams;
    },
  };
  return Object.freeze(
    blindCast<
      RunnableServiceNode<D, P & ReservedParams, E>,
      "the spread copies node's own enumerable data (including the Symbol.for brand) and adds run/load — exactly RunnableServiceNode's shape"
    >(runnable),
  );
};
