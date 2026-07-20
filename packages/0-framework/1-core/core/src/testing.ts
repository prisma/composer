/**
 * The unit-test seam (testing.md § Unit): `mockService` replaces a service
 * node's `load()` and `config()` output so any code that pulls dependencies or
 * params through them — a page, a server action, a helper — runs against typed
 * doubles with no server and no environment. Target-agnostic: every service
 * node has `load()`/`config()`. It does no module mocking; wiring the
 * substitution into a test runner (`vi.mock`, `mock.module`) stays in the test.
 * The integration seam (`bootstrapService`) is target-specific and lives in the
 * target's own testing entry (e.g. `@prisma/composer-prisma-cloud/testing`).
 */
import { blindCast } from '@internal/foundation/casts';
import type { Params, Values } from './config.ts';
import type { Deps, Expose, HydratedDeps, RunnableServiceNode, Secrets } from './node.ts';

/**
 * `mockService`'s override argument: every declared dependency, typed against
 * its own hydrated shape (`Client<C>` for an RPC dep, the resource binding
 * for a resource dep) — a double of the wrong shape is a compile error. The
 * service's own params are optional; an omitted one falls back to its
 * declared default, same as a real `load()`.
 */
export type LoadOverrides<D extends Deps, P extends Params> = HydratedDeps<D> & Partial<Values<P>>;

function paramDefaults<P extends Params>(params: P): Partial<Values<P>> {
  const defaults: Record<string, unknown> = {};
  for (const [name, param] of Object.entries(params)) {
    if (param.default !== undefined) defaults[name] = param.default;
  }
  return blindCast<
    Partial<Values<P>>,
    "assembled from each param declaration's own default value, one key per param that declares one — exactly Partial<Values<P>> by construction"
  >(defaults);
}

/**
 * Returns a service node whose `load()` yields the dependency doubles and
 * `config()` yields the service's params (defaults overlaid with any
 * overrides) — everything else about the node (its deps, params, build,
 * expose) is unchanged. `overrides` is one flat object: dependency keys route
 * to `load()`, param keys to `config()`. `run()` is not meaningful on a mock
 * (there is no boot, no environment) and throws if called.
 */
export function mockService<D extends Deps, P extends Params, E extends Expose, S extends Secrets>(
  service: RunnableServiceNode<D, P, E, S>,
  overrides: LoadOverrides<D, P>,
): RunnableServiceNode<D, P, E, S> {
  const entries = Object.entries(overrides);
  const deps = blindCast<
    HydratedDeps<D>,
    "the override entries whose key names a declared dependency — LoadOverrides already types each against its dep's hydrated shape, so the dependency subset is exactly HydratedDeps<D>"
  >(Object.fromEntries(entries.filter(([name]) => name in service.inputs)));
  const config = blindCast<
    Values<P>,
    'the param defaults overlaid with the override entries whose key names a declared param — every param thus filled, exactly Values<P>'
  >({
    ...paramDefaults(service.params),
    ...Object.fromEntries(entries.filter(([name]) => name in service.params)),
  });

  return Object.freeze({
    ...service,
    run(): Promise<unknown> {
      throw new Error(
        `mockService(): "${service.name}" is a load()/config()-only mock — it has no run() (no boot, no environment).`,
      );
    },
    load: () => deps,
    config: () => config,
  });
}
