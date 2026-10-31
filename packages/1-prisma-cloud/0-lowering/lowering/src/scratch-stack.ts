import { blindCast } from '@internal/foundation/casts';
import * as Alchemy from 'alchemy';
import * as Alchemist from 'alchemy/Alchemist';
import type { StackServices } from 'alchemy/Stack';
import * as State from 'alchemy/State';
import { InMemoryService } from 'alchemy/State/InMemoryState';
import type { ConfigError } from 'effect/Config';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';

/**
 * Runs Alchemy's real plan and apply in-process, through `alchemy/Alchemist`,
 * for Composer's own provider tests; not re-exported by any public package.
 * Each scratch stack owns a private in-memory state, exposed as `state`.
 */
export interface ScratchStackOptions<ROut> {
  readonly providers: Layer.Layer<ROut, never, StackServices>;
  readonly dev?: boolean;
}

const STAGE = 'test';

export const scratchStack = <ROut>(options: ScratchStackOptions<ROut>, name: string) => {
  const stateLayer: Layer.Layer<State.State> = Layer.succeed(State.State, InMemoryService({}));

  const providers = blindCast<
    Layer.Layer<never, never, StackServices>,
    "the program's provider requirements are exactly what these providers supply; Alchemy.Stack ties the two through one inferred type that a generic ROut cannot name"
  >(options.providers);

  const planned = <A, R extends ROut | StackServices>(effect: Effect.Effect<A, ConfigError, R>) =>
    Alchemist.plan({
      stack: Alchemy.Stack(
        name,
        { providers, state: stateLayer },
        blindCast<
          Effect.Effect<A, ConfigError>,
          'its requirements are the providers above and the stack services Alchemy.Stack supplies'
        >(effect),
      ),
      operation: 'deploy',
      stage: STAGE,
      dev: options.dev ?? false,
    });

  return {
    name,
    stage: STAGE,
    state: stateLayer,
    /** Plans and applies `effect` as this stack's program; returns its output. */
    deploy: <A, R extends ROut | StackServices>(effect: Effect.Effect<A, ConfigError, R>) =>
      Effect.scoped(Effect.flatMap(planned(effect), Alchemist.apply)),
    /** Plans `effect` as this stack's program; returns the engine plan. */
    plan: <A, R extends ROut | StackServices>(effect: Effect.Effect<A, ConfigError, R>) =>
      Effect.scoped(Effect.map(planned(effect), (plan) => plan.native)),
  };
};

/** Runs a scratch-stack program with the services `Alchemist.layer()` provides. */
export const runScratch = <A, E>(effect: Effect.Effect<A, E, Alchemist.Services>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(Alchemist.layer())));
