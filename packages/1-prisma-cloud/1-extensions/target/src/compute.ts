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
import { RESERVED_PROVIDER_PARAMS } from './provider-params.ts';
import {
  deserialize,
  readInput,
  readOrigin,
  stash,
  stashInput,
  stashProviderParams,
} from './serializer.ts';

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
 * the control-plane registry key `prisma-composer deploy` resolves through the
 * app's `prisma-composer.config.ts` (ADR-0017). This module loads nothing at
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

  #resolved: Config | undefined;
  #loadedDeps: HydratedDeps<D> | undefined;
  #loadedInput: InputValueOf<I> | undefined;
  #origin: string | undefined;

  constructor(node: ServiceNode<D, ReservedParams, E, I>) {
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
    // Re-emit the input DOCUMENT address-free too, so input() reads the same
    // row with no address (secret values stay only in their platform vars —
    // the document carries pointers, ADR-0042).
    stashInput(this, address);
    // Expose the resolved service port under the near-universal PORT convention,
    // so a framework-unaware server (Next.js's standalone server.js binds the
    // PORT env var) listens on the port Compute routes to — not its own default.
    // A server that reads input().port explicitly is free to ignore it. Read the
    // reserved `port` param the same way serialize does (descriptors/compute.ts).
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

  const instance = new ComputeService<D, I, E>(node);
  Object.freeze(instance);
  return instance;
};
