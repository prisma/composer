import type {
  BuildAdapter,
  Config,
  Deps,
  Expose,
  HydratedDeps,
  NODE,
  Params,
  RunnableServiceNode,
  Secrets,
  SecretValues,
  ServiceNode,
  Values,
} from '@internal/core';
import { hydrateSecrets, hydrateSync, number, service } from '@internal/core';
import { blindCast } from '@internal/foundation/casts';
import { RESERVED_PROVIDER_PARAMS } from './provider-params.ts';
import {
  deserialize,
  deserializeSecrets,
  ORIGIN_KEY_NAME,
  readOrigin,
  stash,
  stashProviderParams,
  stashSecrets,
} from './serializer.ts';

const reservedParams = { port: number({ default: 3000 }) } as const;
type ReservedParams = typeof reservedParams;

/**
 * A Prisma Compute service — declarations only (deps + params + build + the
 * ports it exposes), no descriptor. `params` merges with the reserved
 * `ReservedParams` (`port`); a user param whose name collides with a reserved
 * one fails at authoring, the same way a colliding dependency name does.
 *
 *   · run(address, boot) — the process controller: deserialize the platform
 *     environment (keyed off `address`, the extension's ONE env read) into a
 *     typed Config, re-emit it under address-free process-local stash keys,
 *     then call boot() to start the app's entry.
 *   · load() / config() — called from inside the app's entry: read the stash;
 *     load() hydrates + memoizes the deps, config() returns the typed params.
 *     Separate accessors so a dep and a param never share a namespace (ADR-0021).
 *   · origin() — this service's platform-assigned public origin, read from the
 *     stash `run()` populates; memoized per process.
 *
 * The underlying node carries `extension: '@prisma/composer-prisma-cloud'` —
 * the control-plane registry key `prisma-composer deploy` resolves through the
 * app's `prisma-composer.config.ts` (ADR-0017). This module loads nothing at
 * deploy time; nodes are pure data until run() or load() is called.
 */
export class ComputeService<D extends Deps, P extends Params, E extends Expose, S extends Secrets>
  implements RunnableServiceNode<D, P & ReservedParams, E, S>
{
  // `declare` — no initializer, so the constructor's `Object.assign(this, node)`
  // supplies these at runtime without a field initializer clobbering it
  // afterward. Member types copied verbatim from core's ServiceNode/
  // RunnableServiceNode so this class is an honest `implements`, not a cast.
  declare readonly [NODE]: true;
  declare readonly kind: 'service';
  declare readonly name: string;
  declare readonly extension: string;
  declare readonly type: string;
  declare readonly inputs: D;
  declare readonly params: P & ReservedParams;
  declare readonly secretSlots: S;
  declare readonly build: BuildAdapter;
  declare readonly expose: E | undefined;

  #resolved: Config | undefined;
  #loadedDeps: HydratedDeps<D> | undefined;
  #loadedParams: Values<P & ReservedParams> | undefined;
  #loadedSecrets: SecretValues<S> | undefined;
  #origin: string | undefined;

  constructor(node: ServiceNode<D, P & ReservedParams, E, S>) {
    Object.assign(this, node);
  }

  #processConfig(): Config {
    if (this.#resolved === undefined) this.#resolved = deserialize(this, '');
    return this.#resolved;
  }

  async run(address: string, boot: () => Promise<unknown>) {
    const config = deserialize(this, address);
    stash(this, config);
    // ADR-0031's provider-side sibling of the param re-stash above — the
    // readers are serve()'s accepted keys, the streams entrypoint's API_KEY,
    // and origin() (the framework-resolved ORIGIN row rides the same list).
    // An absent row stays absent (never provisioned); a present one is
    // schema-checked exactly like a declared param before it moves.
    stashProviderParams(RESERVED_PROVIDER_PARAMS, address);
    // Re-emit the secret POINTERS address-free too, so secrets() double-looks-up
    // the same way with no address (the value stays only in its platform var).
    stashSecrets(this, address);
    // Expose the resolved service port under the near-universal PORT convention,
    // so a framework-unaware server (Next.js's standalone server.js binds the
    // PORT env var) listens on the port Compute routes to — not its own default.
    // A server that reads config().port explicitly (e.g. a Bun HTTP listener)
    // simply ignores it. Read the reserved `port` param the same way serialize
    // does (descriptors/compute.ts).
    const port = config.service['port'];
    if (typeof port === 'number') process.env['PORT'] = String(port);
    return boot();
  }

  load(): HydratedDeps<D> {
    if (this.#loadedDeps === undefined) {
      this.#loadedDeps = blindCast<
        HydratedDeps<D>,
        'hydrateSync returns HydratedDeps<Deps>; for this node the deps are D'
      >(hydrateSync(this, this.#processConfig()));
    }
    return this.#loadedDeps;
  }

  config(): Values<P & ReservedParams> {
    if (this.#loadedParams === undefined) {
      this.#loadedParams = blindCast<
        Values<P & ReservedParams>,
        'the deserialized service config record (untyped at runtime) is exactly the typed Values shape'
      >(this.#processConfig().service);
    }
    return this.#loadedParams;
  }

  secrets(): SecretValues<S> {
    if (this.#loadedSecrets === undefined) {
      // Double-lookup (address-free) → resolved strings → SecretBoxes (core).
      this.#loadedSecrets = blindCast<
        SecretValues<S>,
        'hydrateSecrets boxes one string per declared slot; for this node the slots are S'
      >(hydrateSecrets(this, deserializeSecrets(this, '')));
    }
    return this.#loadedSecrets;
  }

  /** This service's platform-assigned public origin — read from the stash
   *  run() populates and memoized per process. Throws if called before run()
   *  has stashed it (readOrigin's pinned message). */
  origin(): string {
    this.#origin ??= readOrigin();
    return this.#origin;
  }
}

export const compute = <
  D extends Deps,
  P extends Params = Record<never, never>,
  E extends Expose = Record<never, never>,
  S extends Secrets = Record<never, never>,
>(def: {
  name: string;
  deps: D;
  params?: P;
  secrets?: S;
  build: BuildAdapter;
  expose?: E;
}): ComputeService<D, P, E, S> => {
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

  // The framework-written origin row (this dispatch) occupies the service's
  // own ORIGIN key, the same key space a user param or secret slot lives in —
  // fail at authoring rather than let either one silently collide with it.
  for (const name of Object.keys(userParams)) {
    if (name.toUpperCase() === ORIGIN_KEY_NAME) {
      throw new Error(
        `compute(): param "${name}" collides with the framework-written origin row — rename the param.`,
      );
    }
  }
  for (const name of Object.keys(def.secrets ?? {})) {
    if (name.toUpperCase() === ORIGIN_KEY_NAME) {
      throw new Error(
        `compute(): secret "${name}" collides with the framework-written origin row — rename the secret.`,
      );
    }
  }

  const params = blindCast<P & ReservedParams, 'reserved params merged over user params'>({
    ...userParams,
    ...reservedParams,
  });
  const node = service<D, P & ReservedParams, E, S>({
    name: def.name,
    extension: '@prisma/composer-prisma-cloud',
    type: 'compute',
    inputs: def.deps,
    params,
    ...(def.secrets !== undefined ? { secrets: def.secrets } : {}),
    build: def.build,
    ...(def.expose !== undefined ? { expose: def.expose } : {}),
  });

  const instance = new ComputeService<D, P, E, S>(node);
  Object.freeze(instance);
  return instance;
};
