/**
 * The unit-test seam (testing.md § Unit): `mockService` replaces a service
 * node's `load()` and `input()` output so any code that pulls dependencies or
 * input through them — a page, a server action, a helper — runs against typed
 * doubles with no server and no environment. Target-agnostic: every service
 * node has `load()`/`input()`. It does no module mocking; wiring the
 * substitution into a test runner (`vi.mock`, `mock.module`) stays in the test.
 * The integration seam (`bootstrapService`) is target-specific and lives in the
 * target's own testing entry (e.g. `@prisma/composer-prisma-cloud/testing`).
 */
import { blindCast } from '@internal/foundation/casts';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { Params } from './config.ts';
import type { Deps, Expose, HydratedDeps, InputValueOf, RunnableServiceNode } from './node.ts';

/**
 * `mockService`'s override argument: every declared dependency, typed against
 * its own hydrated shape (`Client<C>` for an RPC dep, the resource binding
 * for a resource dep) — a double of the wrong shape is a compile error — plus
 * `input`, the already-validated input object, required exactly when the
 * service declares an input schema (ADR-0042). A dependency literally named
 * "input" shadows the input override — rename the dependency.
 */
export type LoadOverrides<
  D extends Deps,
  I extends StandardSchemaV1 | undefined,
> = HydratedDeps<D> &
  (I extends StandardSchemaV1 ? { input: StandardSchemaV1.InferOutput<I> } : { input?: never });

/**
 * Returns a service node whose `load()` yields the dependency doubles and
 * `input()` the given input object — everything else about the node (its
 * deps, input schema, build, expose) is unchanged. The input double is NOT
 * validated: the test supplies the typed, already-validated shape directly.
 * `run()` is not meaningful on a mock (there is no boot, no environment) and
 * throws if called.
 */
export function mockService<
  D extends Deps,
  P extends Params,
  E extends Expose,
  I extends StandardSchemaV1 | undefined,
>(
  service: RunnableServiceNode<D, P, E, I>,
  overrides: LoadOverrides<D, I>,
): RunnableServiceNode<D, P, E, I> {
  const entries = Object.entries(overrides);
  const deps = blindCast<
    HydratedDeps<D>,
    "the override entries whose key names a declared dependency — LoadOverrides already types each against its dep's hydrated shape, so the dependency subset is exactly HydratedDeps<D>"
  >(Object.fromEntries(entries.filter(([name]) => name in service.inputs)));
  const input = blindCast<
    InputValueOf<I>,
    'LoadOverrides requires `input` (typed by the schema) exactly when the service declares an input schema'
  >(entries.find(([name]) => name === 'input')?.[1]);

  return Object.freeze({
    ...service,
    run(): Promise<unknown> {
      throw new Error(
        `mockService(): "${service.name}" is a load()/input()-only mock — it has no run() (no boot, no environment).`,
      );
    },
    load: () => deps,
    input: () => input,
  });
}
