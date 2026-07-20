/** The `prisma-composer.config.ts` surface (ADR-0017): statically imports each extension's node-descriptor registry plus the state store; core defines only the types. */
import type * as Layer from 'effect/Layer';
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
}

/** The resolved deploy context handed to an extension's `preflight` hook. */
export interface PreflightInput {
  /** The loaded application graph — the manifest of prerequisites is read from it (`provisionManifest`). */
  readonly graph: Graph;
  /** The resolved Prisma Cloud Project id. */
  readonly projectId: string;
  /** The resolved Branch id for a named stage; `undefined` for the default (production) stage. */
  readonly branchId: string | undefined;
  /** The stage name (`--stage`), or `undefined` for the default stage — for diagnostics/scope. */
  readonly stage: string | undefined;
}

/** The resolved destroy context handed to an extension's `teardown` hook. */
export interface TeardownInput {
  /** The resolved Prisma Cloud Project id. */
  readonly projectId: string;
  /** The resolved Branch id for a named stage; `undefined` for the default (production) stage. */
  readonly branchId: string | undefined;
  /** The stage name (`--stage`), or `undefined` for the default stage — for diagnostics/scope. */
  readonly stage: string | undefined;
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
  readonly state: () => AlchemyStateLayer;
}

/** Typed identity — exists so `prisma-composer.config.ts` gets checked against PrismaAppConfig where it is written. */
export function defineConfig(config: PrismaAppConfig): PrismaAppConfig {
  return config;
}
