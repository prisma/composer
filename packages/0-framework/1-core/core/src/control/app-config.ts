/** The `prisma-composer.config.ts` surface (ADR-0017): statically imports each extension's node-descriptor registry plus the state store; core defines only the types. */
import type * as Layer from 'effect/Layer';
import type {
  ContainerCredentials,
  ContainerDescriptor,
  ContainerInstance,
} from '../container-transport.ts';
import type { Graph } from '../graph.ts';
import type { PreflightPayload } from '../preflight-transport.ts';
import type {
  AlchemyStateLayer,
  ApplicationDescriptor,
  AssembleInput,
  Bundle,
  DeployedEntity,
  Lowering,
  ProvisionerDescriptor,
  ServiceLowering,
} from './deploy.ts';

export type {
  ContainerCredentials,
  ContainerDescriptor,
  ContainerInstance,
  LocateContainerInput,
} from '../container-transport.ts';
export {
  containerEnv,
  containerEnvVarName,
  deserializeContainers,
} from '../container-transport.ts';
export type { PreflightPayload } from '../preflight-transport.ts';
export {
  preflightEnv,
  preflightEnvVarName,
  readPreflightPayload,
} from '../preflight-transport.ts';
/** Re-exported because `RunOutcome` hands them to a reporter — reading this surface must not also require the deploy one. */
export type { DeployedEntity } from './deploy.ts';

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
   *
   * What it returns is carried to the alchemy process for this same extension
   * to read back there (preflight-transport.ts) — preflight runs in the CLI
   * parent, and the alchemy child re-imports the config from scratch, so
   * anything the lowering needs from it must ride that transport. The payload
   * is the extension's own opaque string; the framework never reads it, and a
   * secret value must never go in it.
   *
   * METHOD SYNTAX REQUIRED, for the same reason ContainerDescriptor's members
   * need it: the framework hands over the erased `PreflightInput<unknown>`,
   * and an extension that types the input against its own client type only
   * assigns here through method bivariance.
   */
  preflight?(input: PreflightInput): Promise<PreflightPayload>;
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
   * Deploy-run reporting. The CLI begins a session after the graph is loaded
   * and before containers are resolved, and finishes it on every exit path.
   * An extension without one reports nothing, which is the default.
   */
  readonly reporter?: ReporterDescriptor;
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

/** The resolved deploy context handed to an extension's `preflight` hook. `C` erases to `unknown` at the framework boundary — see ContainerCredentials. */
export interface PreflightInput<C = unknown> {
  /** The loaded application graph — the manifest of prerequisites is read from it (`provisionManifest`). */
  readonly graph: Graph;
  /** The calling extension's own resolved container; `undefined` when it declares no container descriptor. Narrow with the extension's guard. */
  readonly container: ContainerInstance | undefined;
  /** The stage name (`--stage`), or `undefined` for the default stage — for diagnostics/scope. */
  readonly stage: string | undefined;
  /** What the caller has already authenticated, for the platform calls preflight makes. Absent means the extension falls back to its own credential protocol. */
  readonly credentials?: ContainerCredentials<C> | undefined;
}

/** The resolved destroy context handed to an extension's `teardown` hook. */
export interface TeardownInput {
  /** The calling extension's own resolved container; `undefined` when it declares no container descriptor. Narrow with the extension's guard. */
  readonly container: ContainerInstance | undefined;
  /** The stage name (`--stage`), or `undefined` for the default stage — for diagnostics/scope. */
  readonly stage: string | undefined;
}

/** The deploy context handed to `ReporterDescriptor.begin`. `C` erases to `unknown` at the framework boundary, exactly as on `PreflightInput`. */
export interface ReportBeginInput<C = unknown> {
  /** The resolved application name. */
  readonly appName: string;
  /** The loaded application graph — what this deploy declares. A reporter that records the declared topology reads it here. */
  readonly graph: Graph;
  /** The stage name (`--stage`), or `undefined` for the default stage. */
  readonly stage: string | undefined;
  /** The directory the deploy command was run from — where a reporter reads repository metadata. */
  readonly cwd: string;
  /**
   * An existing report record this deploy is one part of, when whatever
   * invoked Composer created one first — a CI job that opens the record, runs
   * several steps against it, and closes it afterwards. Opaque to core: only
   * the reporter knows what record the id names, and a reporter that receives
   * one joins it instead of creating its own.
   *
   * Takes precedence over any equivalent the reporter reads from the
   * environment, because it was passed deliberately.
   */
  readonly reportId: string | undefined;
  /** What the caller has already authenticated, exactly as `preflight` and the container lifecycle receive it. Present means the reporter must not build a client from the environment. */
  readonly credentials?: ContainerCredentials<C> | undefined;
}

/** The deploy context handed to `RunReporter.attach`, once containers exist. */
export interface ReportAttachInput {
  /** The calling extension's own resolved container; `undefined` when it declares no container descriptor. Narrow with the extension's guard. */
  readonly container: ContainerInstance | undefined;
}

/** How a run ended, as a reporter sees it. */
export interface RunOutcome {
  readonly ok: boolean;
  /** The run was interrupted (the engine settled a Ctrl-C or a termination signal) — a kind of not-ok that is not a failure. Only meaningful when `ok` is false. */
  readonly cancelled: boolean;
  /** The failing step's name — the deploy's own error code. `undefined` when the run succeeded. */
  readonly failingStep: string | undefined;
  /** Human-readable detail. `undefined` when the run succeeded. */
  readonly errorMessage: string | undefined;
  /**
   * Everything the run's nodes became on the deployment target, flattened.
   * Core does not interpret a `kind` and neither should the CLI — a reporter
   * reads the kinds its own extension emits and ignores the rest. Empty when
   * the run failed before producing a report.
   */
  readonly entities: readonly DeployedEntity[];
}

/**
 * One run's reporting session. Every method is best-effort by contract:
 * reporting is observability, never a step of the deploy, so an
 * implementation logs its own failures and resolves rather than rejecting.
 * The CLI does not catch, and will not fail a deploy over a report.
 */
export interface RunReporter {
  /**
   * Extra environment for the alchemy child, so reporting that happens
   * inside the apply can find the run this session belongs to. Read once,
   * after `attach`, and merged into the child's environment.
   */
  childEnv(): Readonly<Record<string, string>>;
  /** Called once the extension's own container is resolved, before any stack file is written — the moment the run's project and branch first exist to be referenced. */
  attach(input: ReportAttachInput): Promise<void>;
  /** Called exactly once, on every exit path including a thrown error. */
  finish(outcome: RunOutcome): Promise<void>;
}

/**
 * Deploy-run reporting — how an extension records that a deploy happened,
 * how far it got, and how it ended. The CLI begins a session after the app's
 * graph is loaded and before its containers are resolved, so a failure while
 * creating them is still reported, and finishes it on every exit path.
 *
 * Deploy only: `destroy` has no reportable shape on the Prisma Cloud side
 * (its build phases name a deploy), so the CLI does not run this hook there.
 */
export interface ReporterDescriptor {
  /**
   * Start a session, or return `undefined` when there is nothing to report
   * against (no credentials, no repository). Never throws. METHOD SYNTAX
   * REQUIRED, like `preflight`: the framework hands over the erased
   * `ReportBeginInput<unknown>`, and a reporter that types the input against
   * its own client type only assigns here through method bivariance.
   */
  begin(input: ReportBeginInput): Promise<RunReporter | undefined>;
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
