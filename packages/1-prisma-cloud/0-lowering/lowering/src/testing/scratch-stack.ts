import { AdoptPolicy } from 'alchemy/AdoptPolicy';
import { AlchemyContext, AlchemyContextLive } from 'alchemy/AlchemyContext';
import { type ArtifactStore, provideFreshArtifactStore } from 'alchemy/Artifacts';
import { AuthProviders } from 'alchemy/Auth/AuthProvider';
import { CredentialsStoreLive } from 'alchemy/Auth/Credentials';
import { ProfileStoreLive } from 'alchemy/Auth/Profile';
import { LoggingCli } from 'alchemy/Cli/LoggingCli';
import * as Deploy from 'alchemy/Deploy';
import * as Interaction from 'alchemy/Interaction';
import * as Plan from 'alchemy/Plan';
import { make as makeStack, type StackEffect, type StackServices } from 'alchemy/Stack';
import { Stage } from 'alchemy/Stage';
import * as State from 'alchemy/State';
import { InMemoryService } from 'alchemy/State/InMemoryState';
import { kindOf } from 'alchemy/Util/LogRecord';
import { PlatformServices } from 'alchemy/Util/PlatformServices';
import * as Effect from 'effect/Effect';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as Layer from 'effect/Layer';
import * as Logger from 'effect/Logger';

/**
 * Runs Alchemy's real plan and apply engine in-process against a private
 * in-memory state, for provider tests. A port of the scratch-stack harness
 * Alchemy kept in `alchemy/Test/Core` up to 2.0.0-beta.83, without its
 * emulator and sidecar support.
 */
export interface ScratchStackOptions<ROut> {
  readonly providers: Layer.Layer<ROut, never, StackServices>;
  readonly state: Layer.Layer<State.State>;
  readonly dev?: boolean;
}

const STAGE = 'test';

export const scratchStack = <ROut>(options: ScratchStackOptions<ROut>, name: string) => {
  const stateLayer: Layer.Layer<State.State> = Layer.succeed(State.State, InMemoryService({}));

  const compile = <A, E, R extends ROut | StackServices>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      makeStack<ROut>({ name, providers: options.providers, state: stateLayer }),
      Effect.provideService(Stage, STAGE),
    );

  return {
    name,
    stage: STAGE,
    state: stateLayer,
    deploy: <A, E, R extends ROut | StackServices>(effect: Effect.Effect<A, E, R>) =>
      compile(effect).pipe(
        Effect.flatMap((compiled) =>
          Plan.make(compiled).pipe(
            Effect.flatMap(Deploy.applyAndRender),
            Effect.provide(compiled.services),
          ),
        ),
        provideFreshArtifactStore,
      ),
    plan: <A, E, R extends ROut | StackServices>(effect: Effect.Effect<A, E, R>) =>
      compile(effect).pipe(
        Effect.flatMap((compiled) => Plan.make(compiled).pipe(Effect.provide(compiled.services))),
        provideFreshArtifactStore,
      ),
  };
};

const platformLayer = Layer.mergeAll(
  PlatformServices,
  FetchHttpClient.layer,
  Layer.provide(ProfileStoreLive, PlatformServices),
  Layer.provide(CredentialsStoreLive, PlatformServices),
);

const alchemyLayer = Layer.mergeAll(
  LoggingCli,
  Interaction.layerNonInteractive(),
  AlchemyContextLive,
);

const overrideDev = (dev: boolean) =>
  Layer.effect(AlchemyContext, AlchemyContext.pipe(Effect.map((context) => ({ ...context, dev }))));

/** Drops the typed event records; the `LoggingCli` lines already report progress. */
const withoutEventRecords = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(Logger.CurrentLoggers, (loggers) =>
    effect.pipe(
      Effect.provideService(
        Logger.CurrentLoggers,
        new Set(
          [...loggers].map((logger) =>
            Logger.make<unknown, void>((options) => {
              if (kindOf(options) !== 'event') logger.log(options);
            }),
          ),
        ),
      ),
    ),
  );

/** Runs a scratch-stack program with the services the Alchemy CLI would provide. */
export const runScratch = <A, E, ROut>(
  effect: StackEffect<A, E>,
  options: ScratchStackOptions<ROut>,
): Promise<A> =>
  Effect.runPromise(
    provideFreshArtifactStore<A, E, Exclude<Effect.Services<typeof effect>, ArtifactStore>>(
      effect,
    ).pipe(
      withoutEventRecords,
      Effect.provideService(AdoptPolicy, false),
      Effect.provide(overrideDev(options.dev ?? false)),
      Effect.provide(options.state),
      Effect.provideService(AuthProviders, {}),
      Effect.provide(Layer.provideMerge(alchemyLayer, platformLayer)),
      Effect.scoped,
    ),
  );
