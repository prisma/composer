/** The `prisma-composer.config.ts` surface (ADR-0017): statically imports each extension's node-descriptor registry plus the state store; core defines only the types. */
import type * as Layer from 'effect/Layer';
import type { ContainerDescriptor, ContainerInstance } from '../container-transport.ts';
import type { Graph } from '../graph.ts';
import type {
  AlchemyStateLayer,
  ApplicationDescriptor,
  AssembleInput,
  Bundle,
  Lowering,
  ProvisionerDescriptor,
  ServiceLowering,
} from './deploy.ts';

export type {
  ContainerDescriptor,
  ContainerInstance,
  LocateContainerInput,
} from '../container-transport.ts';
export {
  containerEnv,
  containerEnvVarName,
  deserializeContainers,
} from '../container-transport.ts';

/**
 * One extension's control-plane registry: everything the deploy pipeline may
 * look up for a node whose `extension` field names this package. `nodes` is
 * keyed by the node's within-extension ID (`node.type` / `build.type`).
 */
export interface ExtensionDescriptor {
  /** The extension's package name, e.g. "@prisma/composer-prisma-cloud" — what a node's `extension` field is matched against. */
  readonly id: string;
  /** ONE registry per extension, keyed by node ID. */
  readonly nodes: Record<string, NodeDescriptor>;
  /** Param provisioners this extension supplies, keyed by need brand (ADR-0031). Core resolves a param's ProvisionNeed against the CONSUMER extension's map. */
  readonly provisions?: ReadonlyMap<symbol, ProvisionerDescriptor>;
  /** Once-per-lowering hook — the application's shared infrastructure (e.g. prisma-cloud's Project). */
  readonly application?: ApplicationDescriptor;
  /** The extension's Alchemy providers — merged across all configured extensions (config order). */
  readonly providers?: () => Layer.Layer<never>;
  /**
   * Deploy-time prerequisite check — the CLI runs it once, after the app's
   * Project/Branch are resolved and BEFORE any stack file is written or Alchemy
   * runs. A target uses it to verify platform prerequisites (e.g. that every
   * secret env var in the provision manifest exists for the resolved stage) and
   * throws to abort the deploy. Async: it talks to the platform (ADR-0029).
   */
  readonly preflight?: (input: PreflightInput) => Promise<void>;
  /**
   * Destroy-time cleanup — the CLI runs it once, after `alchemy destroy`
   * succeeds and BEFORE the stage's Project/Branch are removed. A target uses
   * it to remove infrastructure it owns outside the stack (e.g. the deploy
   * state store, which the destroy above was still reading). Throwing aborts
   * the destroy before the containers go; a target that would rather warn than
   * fail the command handles that itself. Async: it talks to the platform.
   */
  readonly teardown?: (input: TeardownInput) => Promise<void>;
  /**
   * The extension's container lifecycle, when its platform has containers
   * (ADR-0038). The CLI resolves containers after assembly and before any
   * stack file or Alchemy run (deploy ensures, destroy locates); the
   * resolved instance reaches the alchemy process through the env transport
   * in container-transport.ts.
   */
  readonly container?: ContainerDescriptor;
  /**
   * The extension's LOCAL TARGET counterpart (ADR-0041; naming, operator
   * 2026-07-23 — "dev" names the user-facing feature only, the seam takes
   * the concept's real noun) — a LAZY reference: an async thunk, never the
   * descriptor object itself. This keeps the production control entry's
   * static import graph free of local-target implementation code (operator
   * directive) — the thunk is one line, dynamically importing the
   * extension's own local-target entry by bare specifier
   * (e.g. `() => import('@prisma/composer-prisma-cloud/local-target').then((m) => m.localTargetDescriptor())`),
   * so nothing local-target-flavored is bundled into, or loaded by, any
   * deploy path.
   */
  readonly localTarget?: () => Promise<LocalTargetDescriptor>;
}

/**
 * The deploy's one state store. It names its owning extension so core knows
 * whose resolved container to pass into `create` (ADR-0038).
 */
export interface StateDescriptor {
  /** The owning extension's id — matched against `ExtensionDescriptor.id`. */
  readonly extension: string;
  /** Build the state layer. `container` is the owning extension's resolved instance; `undefined` when it declared no container descriptor. */
  create(container: ContainerInstance | undefined): AlchemyStateLayer;
}

/** The resolved deploy context handed to an extension's `preflight` hook. */
export interface PreflightInput {
  /** The loaded application graph — the manifest of prerequisites is read from it (`provisionManifest`). */
  readonly graph: Graph;
  /** The calling extension's own resolved container; `undefined` when it declares no container descriptor. Narrow with the extension's guard. */
  readonly container: ContainerInstance | undefined;
  /** The stage name (`--stage`), or `undefined` for the default stage — for diagnostics/scope. */
  readonly stage: string | undefined;
}

/** The resolved destroy context handed to an extension's `teardown` hook. */
export interface TeardownInput {
  /** The calling extension's own resolved container; `undefined` when it declares no container descriptor. Narrow with the extension's guard. */
  readonly container: ContainerInstance | undefined;
  /** The stage name (`--stage`), or `undefined` for the default stage — for diagnostics/scope. */
  readonly stage: string | undefined;
}

/** The extension's LOCAL TARGET counterpart (ADR-0041) — the local-target variant OF ExtensionDescriptor, hence the full qualifier. An extension without one is not local-target-capable (cannot back the "dev" feature). */
export interface LocalTargetDescriptor {
  /** Local providers for the SAME resource types this extension's lowering emits. Receives the app identity — unlike deploy's env-arg-free `providers()`, local providers are emulator clients and must know which app they provision for. */
  providers(input: LocalTargetProvidersInput): Layer.Layer<never>;
  /** A stable local identity — resolved without any platform call. */
  readonly container: ContainerDescriptor;
  /** Value sourcing (secrets/env-params) — runs where deploy's preflight runs. */
  preflight?(input: PreflightInput): Promise<void>;
  /** Ensure the emulator daemons this topology's node kinds need are running (idempotent; they persist across sessions). */
  emulators?(input: LocalTargetEmulatorsInput): Promise<void>;
  /** The dev session's view of the running app. Core renders it and never learns an emulator's API. */
  attach(input: LocalTargetAttachInput): Promise<LocalTargetAttachment>;
  /** `--fresh`: remove every local trace of the dev instance — emulator instances, state, data. */
  teardown?(input: TeardownInput): Promise<void>;
}

export interface LocalTargetProvidersInput {
  /** This extension's resolved local-target container (its `input.appName` is the emulator app namespace). */
  readonly container: ContainerInstance | undefined;
  /** Absolute path of the dev state directory (`<cwd>/.prisma-composer/dev`). */
  readonly devDir: string;
}

export interface LocalTargetEmulatorsInput {
  /** The loaded application graph — inspected for which node kinds need an emulator. */
  readonly graph: Graph;
  readonly container: ContainerInstance | undefined;
  /** Absolute path of the dev state directory (`<cwd>/.prisma-composer/dev`). */
  readonly devDir: string;
}

export interface LocalTargetAttachInput {
  readonly container: ContainerInstance | undefined;
  readonly devDir: string;
}

export interface LocalTargetAttachment {
  /** Start every stopped service from its last deployment (the session-resume signal — a no-op converge cannot start anything). */
  startServices(): Promise<void>;
  /** Every service's local endpoint, for the front door. */
  endpoints(): Promise<readonly { readonly address: string; readonly url: string }[]>;
  /** Merged, line-oriented log stream across the app's services (including services that appear after later converges). `opts.tail` is how many trailing lines of existing history to emit before live output (default 0 — live only). Ends when `signal` aborts. */
  logs(
    signal: AbortSignal,
    opts?: { readonly tail?: number },
  ): AsyncIterable<{ readonly service: string; readonly line: string }>;
  /** Stop the app's service instances (emulators and data persist). */
  stopServices(): Promise<void>;
}

/** `<cwd>/.prisma-composer/dev` — the dev instance's app-scoped state directory (ADR-0041, ADR-0004's tool-state rule). "dev" names the user-facing feature/dir (naming, operator 2026-07-23) — this constant's name and value are unchanged by the localTarget rename. */
export const DEV_DIR = '.prisma-composer/dev';

/**
 * True when an extension only participates in assembly (every `nodes` entry
 * is `kind: 'build'`, and it declares none of `providers`/`application`/
 * `provisions`/`container`) — it owns no resources or services, so it has
 * nothing to emulate and is exempt from local-target-capability requirements
 * (ADR-0041). Shared by `localTargetProviders` and every local-target hook
 * iteration.
 */
export function isBuildOnlyExtension(extension: ExtensionDescriptor): boolean {
  return (
    Object.values(extension.nodes).every((node) => node.kind === 'build') &&
    extension.providers === undefined &&
    extension.application === undefined &&
    extension.provisions === undefined &&
    extension.container === undefined
  );
}

/**
 * What one registry entry can do. The `kind` discriminant is checked at every
 * lookup site against what the site needs — a resource node looked up against
 * a `service` descriptor is an error naming (extension, type, expected kind).
 */
export type NodeDescriptor =
  | ({ readonly kind: 'resource' } & Lowering)
  | ({ readonly kind: 'service' } & ServiceLowering)
  | { readonly kind: 'build'; assemble(input: AssembleInput): Promise<Bundle> };

/**
 * The config file's default export. `extensions` lists every extension the
 * app deploys through; `state` is the ONE state store per deploy — explicit,
 * platform-agnostic, never defaulted by an extension.
 */
export interface PrismaAppConfig {
  readonly extensions: ExtensionDescriptor[];
  readonly state: StateDescriptor;
}

/** Typed identity — exists so `prisma-composer.config.ts` gets checked against PrismaAppConfig where it is written. */
export function defineConfig(config: PrismaAppConfig): PrismaAppConfig {
  return config;
}
