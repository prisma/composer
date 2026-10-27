import type {
  BuildAdapter,
  Config,
  Deps,
  Expose,
  HydratedDeps,
  InputValueOf,
  NODE,
  RunnableServiceNode,
  ServiceNode,
} from '@internal/core';
import { hydrateSync, number, service } from '@internal/core';
import { blindCast } from '@internal/foundation/casts';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { deserialize, readInput, readOrigin, stashRows } from './serializer.ts';

const reservedParams = { port: number({ default: 3000 }) } as const;
type ReservedParams = typeof reservedParams;

/**
 * A Prisma Compute service — declarations only (deps + one input schema +
 * build + the ports it exposes), no descriptor. The reserved `port` param
 * rides its own channel (ADR-0042 leaves it untouched); a dependency named
 * like it fails at authoring.
 *
 *   · run(address, boot) — the process controller: deserialize the platform
 *     environment (keyed off `address`, the extension's ONE env read) into a
 *     typed Config, re-emit it (and the input document row) under address-free
 *     process-local stash keys, then call boot() to start the app's entry.
 *   · load() / input() — called from inside the app's entry: read the stash;
 *     load() hydrates + memoizes the deps, input() parses the input document,
 *     replaces each `$secret` pointer with a redacting box over the named
 *     platform var, validates with the declared schema, and memoizes (ADR-0042).
 *   · origin() — this service's platform-assigned public origin, read from the
 *     stash `run()` populates; memoized per process.
 *   · port() — this service's resolved reserved port (the value `run()` routes
 *     to and exports as PORT), read from that same stash via #processConfig();
 *     defaults to 3000 when the platform binds none.
 *
 * The underlying node carries `extension: '@prisma/composer-prisma-cloud'` —
 * the control-plane registry key `prisma deploy` resolves through the
 * app's `prisma.config.ts` (ADR-0017). This module loads nothing at
 * deploy time; nodes are pure data until run() or load() is called.
 */
export class ComputeService<
  D extends Deps,
  I extends StandardSchemaV1 | undefined,
  E extends Expose,
> implements RunnableServiceNode<D, ReservedParams, E, I>
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
  declare readonly params: ReservedParams;
  declare readonly inputSchema: I;
  declare readonly build: BuildAdapter;
  declare readonly expose: E | undefined;
  /** Whether the service listens on its port. `prisma dev` waits for the port only when it does. */
  readonly listens: boolean;

  #resolved: Config | undefined;
  #loadedDeps: HydratedDeps<D> | undefined;
  #loadedInput: InputValueOf<I> | undefined;
  #origin: string | undefined;

  constructor(node: ServiceNode<D, ReservedParams, E, I>, listens: boolean) {
    Object.assign(this, node);
    this.listens = listens;
  }

  #processConfig(): Config {
    if (this.#resolved === undefined) this.#resolved = deserialize(this, '');
    return this.#resolved;
  }

  async run(address: string, boot: () => Promise<unknown>) {
    // The address-free stash, PORT and HOST — the same rows a dev server is
    // started with under `prisma dev` (ADR-0056), so the two cannot drift.
    Object.assign(process.env, stashRows(this, address, process.env));
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

  input(): InputValueOf<I> {
    if (this.#loadedInput === undefined) {
      this.#loadedInput = blindCast<
        InputValueOf<I>,
        "readInput validates the hydrated document with this node's own declared schema, so its unknown return is exactly the schema's inferred output"
      >(readInput(this, ''));
    }
    return this.#loadedInput;
  }

  /** This service's platform-assigned public origin — read from the stash
   *  run() populates and memoized per process. Throws if called before run()
   *  has stashed it (readOrigin's pinned message). */
  origin(): string {
    this.#origin ??= readOrigin();
    return this.#origin;
  }

  /** This service's resolved reserved port — the value run() routes to and
   *  exports as PORT — read the same way load() reads the stash. Defaults to
   *  3000 when the platform binds none. */
  port(): number {
    const port = this.#processConfig().service['port'];
    if (typeof port !== 'number') {
      throw new Error(
        `service "${this.name}" resolved a non-numeric port — the reserved port param is number({ default: 3000 }), so a stashed config always carries a number here.`,
      );
    }
    return port;
  }
}

export const compute = <
  D extends Deps,
  I extends StandardSchemaV1 | undefined = undefined,
  E extends Expose = Record<never, never>,
>(def: {
  name: string;
  deps: D;
  input?: I;
  build: BuildAdapter;
  expose?: E;
  /** `false` for a service that never listens on its port, such as a scheduler. Defaults to `true`. */
  listens?: boolean;
}): ComputeService<D, I, E> => {
  // A dependency whose name collides with the reserved `port` param would
  // share its config-key prefix; fail at authoring instead.
  for (const reserved of Object.keys(reservedParams)) {
    if (reserved in def.deps) {
      throw new Error(
        `compute(): dependency "${reserved}" collides with the reserved service param of the same name — rename the dependency.`,
      );
    }
  }

  const node = service<D, ReservedParams, E, I>({
    name: def.name,
    extension: '@prisma/composer-prisma-cloud',
    type: 'compute',
    inputs: def.deps,
    params: reservedParams,
    ...(def.input !== undefined ? { input: def.input } : {}),
    build: def.build,
    ...(def.expose !== undefined ? { expose: def.expose } : {}),
  });

  const instance = new ComputeService<D, I, E>(node, def.listens ?? true);
  Object.freeze(instance);
  return instance;
};
