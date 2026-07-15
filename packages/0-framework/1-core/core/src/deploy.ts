/** Routes each graph node to its extension descriptor (by node.extension/type) and runs provision → serialize → package → deploy in dependency order. */

import type { StackServices } from 'alchemy';
import * as Alchemy from 'alchemy';
import type { State } from 'alchemy/State/State';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import type { ExtensionDescriptor, NodeDescriptor, PrismaAppConfig } from './app-config.ts';
import type { Config } from './config.ts';
import { type Graph, Load, type NodeId } from './graph.ts';
import type { BuildAdapter, ModuleNode, ResourceNode, ServiceNode } from './node.ts';

/** The Layer shape every Alchemy state store must satisfy — what `LowerOptions.state` and `PrismaAppConfig.state` both traffic in. */
export type AlchemyStateLayer = Layer.Layer<State, never, StackServices>;

/**
 * An extension's application-level descriptor: shared infrastructure that runs
 * once per lowering, before any node. Its outputs reach the extension's own
 * SPI calls via LowerContext.application.
 */
export interface ApplicationDescriptor {
  provision(ctx: LowerContext): Effect.Effect<LoweredNode, unknown, unknown>;
}

/** The phased service SPI — the seam between the phases belongs to CORE. */
export interface ServiceLowering {
  /** Makes the platform-specific thing that will host the service — identity-bearing infrastructure only, no code runs. */
  provision(ctx: LowerContext): Effect.Effect<LoweredNode, unknown, unknown>;
  /**
   * Encodes the typed Config into the service's runtime environment. Boot-side
   * deserialize reverses it through the same serializer. Returns the env-var
   * records so `deploy` can reference them.
   */
  serialize(
    ctx: LowerContext,
    provisioned: LoweredNode,
    config: Config,
  ): Effect.Effect<LoweredNode, unknown, unknown>;
  /**
   * Prints the bootstrap and assembles the deployable artifact from the
   * app-built bundle. Must be byte-deterministic: an unchanged service noops
   * on redeploy.
   */
  package(ctx: LowerContext, input: PackageInput): Effect.Effect<Artifact, unknown, unknown>;
  /** Ships the packaged artifact into the provisioned thing and runs it. Returns the trustworthy URL. */
  deploy(
    ctx: LowerContext,
    provisioned: LoweredNode,
    artifact: Artifact,
    serialized: LoweredNode,
  ): Effect.Effect<LoweredNode, unknown, unknown>;
}

/** Input to an extension's package() step: the built bundle and the node's graph address. */
export interface PackageInput {
  /** The build descriptor's normalized output: the bundle dir + the app's runnable. */
  readonly assembled: Bundle;
  /** The node's graph address — baked into the printed bootstrap. */
  readonly address: string;
}

/** One node's realization. Runs inside the Alchemy stack effect. */
export type Lowering = (ctx: LowerContext) => Effect.Effect<LoweredNode, unknown, unknown>;

export interface LowerContext {
  readonly id: NodeId;
  /**
   * The node's deployment address: its full, dot-joined hierarchical
   * position in the graph (e.g. "auth.api"). The config-key namespace and
   * the bootstrap parameter.
   */
  readonly address: string;
  readonly node: ServiceNode | ResourceNode;
  readonly graph: Graph;
  readonly opts: LowerOptions;
  /** The owning extension's application hook outputs (`{ outputs: {} }` when it declares none). */
  readonly application: LoweredNode;
  /** Already-lowered deps (topo order). */
  readonly lowered: ReadonlyMap<NodeId, LoweredNode>;
}

/**
 * What a lowering hands downstream — e.g. a deployed URL a later node's env
 * wiring consumes. The inter-node config-wiring hook for Connections.
 */
export interface LoweredNode {
  readonly outputs: Readonly<Record<string, unknown>>;
}

export interface LowerOptions {
  /** Stack + root node id. */
  readonly name: string;
  // One assembled bundle per provisioned service, keyed by the service's
  // full hierarchical address (its graph id).
  readonly bundles: Record<string, Bundle>;
  readonly stage?: string;
  /** Alchemy state store for the stack. Defaults to the config's own state layer. */
  readonly state?: AlchemyStateLayer;
}

/** A build descriptor's normalized output: the produced bundle dir plus the app's runnable entry within it. */
export interface Bundle {
  readonly dir: string;
  readonly entry: string;
}

/** Shared input shape for every extension's build descriptor. */
export interface AssembleInput {
  readonly build: BuildAdapter;
  /** Extra patterns to inline into the wrapper besides `@prisma/compose*` (e.g. the app's own workspace packages). */
  readonly wrapperNoExternal?: readonly RegExp[];
}

/** package()'s product. */
export interface Artifact {
  readonly path: string;
  readonly sha256: string;
}

export class LowerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LowerError';
  }
}

/** Assembles a service's typed Config from its dependency edges' lowered outputs plus its own param defaults. */
export function buildConfig(
  node: ServiceNode,
  id: NodeId,
  graph: Graph,
  lowered: ReadonlyMap<NodeId, LoweredNode>,
): Config {
  const inputs: Record<string, Record<string, unknown>> = {};

  for (const [inputName, inputNode] of Object.entries(node.inputs)) {
    const edge = graph.edges.find(
      (e) => e.to === id && e.input === inputName && e.kind === 'dependency',
    );
    const producedOutputs = edge !== undefined ? (lowered.get(edge.from)?.outputs ?? {}) : {};
    const values: Record<string, unknown> = {};
    for (const name of Object.keys(inputNode.connection.params)) {
      values[name] = producedOutputs[name];
    }
    inputs[inputName] = values;
  }

  const service: Record<string, unknown> = {};
  for (const [name, param] of Object.entries(node.params)) {
    if (param.default !== undefined) service[name] = param.default;
  }

  return { service, inputs };
}

function missingBundleError(id: NodeId): LowerError {
  return new LowerError(
    `No bundle provided for service "${id}" (opts.bundles["${id}"] is required).`,
  );
}

function duplicateExtensionError(id: string): LowerError {
  return new LowerError(
    `Extension "${id}" is listed more than once in \`extensions\` — each extension id must be unique.`,
  );
}

/** Registries as extension id → descriptor. Fails on a duplicate id — the CLI validates config, but lowering() is the programmatic escape hatch that doesn't. */
function extensionsById(
  config: PrismaAppConfig,
): Effect.Effect<ReadonlyMap<string, ExtensionDescriptor>, LowerError> {
  const map = new Map<string, ExtensionDescriptor>();
  for (const extension of config.extensions) {
    if (map.has(extension.id)) return Effect.fail(duplicateExtensionError(extension.id));
    map.set(extension.id, extension);
  }
  return Effect.succeed(map);
}

function unknownExtensionError(extension: string, id: NodeId): LowerError {
  return new LowerError(
    `No extension "${extension}" is configured (needed by node "${id}") — add it to ` +
      "prisma-compose.config.ts's `extensions` (import its /control entry and list its descriptor).",
  );
}

function unknownNodeTypeError(extension: ExtensionDescriptor, type: string): LowerError {
  return new LowerError(
    `Extension "${extension.id}" has no descriptor for node type "${type}" ` +
      `(known: ${Object.keys(extension.nodes).join(', ')}).`,
  );
}

function wrongKindError(
  extension: string,
  type: string,
  expected: string,
  got: string,
): LowerError {
  return new LowerError(
    `Extension "${extension}"'s descriptor for node type "${type}" is a "${got}" descriptor — ` +
      `this node needs a "${expected}" descriptor.`,
  );
}

/** Looks up one node's descriptor: extension by `node.extension`, then descriptor by `node.type`, then the kind check. */
function descriptorFor(
  extensions: ReadonlyMap<string, ExtensionDescriptor>,
  node: ServiceNode | ResourceNode,
  id: NodeId,
): Effect.Effect<NodeDescriptor, LowerError> {
  const extension = extensions.get(node.extension);
  if (extension === undefined) return Effect.fail(unknownExtensionError(node.extension, id));
  const descriptor = extension.nodes[node.type];
  if (descriptor === undefined) return Effect.fail(unknownNodeTypeError(extension, node.type));
  if (descriptor.kind !== node.kind) {
    return Effect.fail(wrongKindError(node.extension, node.type, node.kind, descriptor.kind));
  }
  return Effect.succeed(descriptor);
}

/**
 * The state-layer precedence a deploy resolves to: an explicit opts.state
 * always wins; failing that, the config's own (required) state. A pure
 * function so the precedence is testable without booting Alchemy.
 */
export function resolveStateLayer(opts: LowerOptions, config: PrismaAppConfig): AlchemyStateLayer {
  return opts.state ?? config.state();
}

/**
 * All configured extensions' providers merged, config array order — an
 * extension without `providers` is skipped; no used-extensions-only
 * filtering (ADR-0017's pinned providers rule).
 */
export function mergedProviders(config: PrismaAppConfig): Layer.Layer<never> {
  const layers = config.extensions.flatMap((extension) =>
    extension.providers !== undefined ? [extension.providers()] : [],
  );
  const [first, ...rest] = layers;
  return first === undefined ? Layer.empty : Layer.mergeAll(first, ...rest);
}

/**
 * Composable form for mixed stacks: hand-wired Alchemy resources alongside Prisma App nodes in one stack effect.
 * Fails with LowerError or whatever an extension's lowering raises — the error type is open.
 */
export function lowering(
  root: ModuleNode,
  config: PrismaAppConfig,
  opts: LowerOptions,
): Effect.Effect<LoweredNode, LowerError, unknown> {
  return Effect.gen(function* () {
    const graph = Load(root, { id: opts.name });
    const extensions = yield* extensionsById(config);
    const lowered = new Map<NodeId, LoweredNode>();

    // Each extension's application hook runs ONCE, before any node, in config
    // order — its outputs reach that extension's own nodes via ctx.application
    // (the same threading the one-target model had).
    const noApplication: LoweredNode = { outputs: {} };
    const applications = new Map<string, LoweredNode>();
    for (const descriptor of config.extensions) {
      if (descriptor.application === undefined) continue;
      const appCtx: LowerContext = {
        id: graph.root.id,
        address: '',
        // Not a specific node — application provisioning is graph-wide.
        node: graph.root.node as never,
        graph,
        opts,
        application: noApplication,
        lowered,
      };
      applications.set(descriptor.id, yield* descriptor.application.provision(appCtx));
    }

    for (const { id, node } of graph.nodes) {
      if (node.kind === 'module') continue; // the transparent root itself — nothing to lower
      // Dependency slots are edges only, never lowered — only module-provisioned
      // resources and services are.
      if (node.kind === 'dependency') continue;

      // A node's graph id IS its deployment address — the same id the bundle
      // correlation key and the config-key namespace both ride.
      const ctx: LowerContext = {
        id,
        address: id,
        node: node as ServiceNode | ResourceNode,
        graph,
        opts,
        application: applications.get(node.extension) ?? noApplication,
        lowered,
      };

      const descriptor = yield* descriptorFor(extensions, node, id);

      if (descriptor.kind === 'resource') {
        lowered.set(id, yield* descriptor(ctx));
        continue;
      }
      if (descriptor.kind !== 'service') {
        // descriptorFor already matched kinds; a 'build' descriptor can never match
        // a graph node's kind — unreachable, kept for TS's exhaustive narrowing.
        return yield* Effect.fail(
          wrongKindError(node.extension, node.type, node.kind, descriptor.kind),
        );
      }

      const service = node as ServiceNode;
      const provisioned = yield* descriptor.provision(ctx);
      const typedConfig = buildConfig(service, id, graph, lowered);
      const serialized = yield* descriptor.serialize(ctx, provisioned, typedConfig);
      const bundle = opts.bundles[id];
      if (bundle === undefined) {
        return yield* Effect.fail(missingBundleError(id));
      }
      const artifact = yield* descriptor.package(ctx, {
        assembled: { dir: bundle.dir, entry: bundle.entry },
        address: id,
      });
      lowered.set(id, yield* descriptor.deploy(ctx, provisioned, artifact, serialized));
    }

    return { outputs: {} };
  }) as Effect.Effect<LoweredNode, LowerError, unknown>;
}

/**
 * The whole-stack wrapper: Load → route each node through the config's
 * extension registries → an Alchemy Stack (the default export the alchemy
 * CLI consumes).
 */
export function lower(root: ModuleNode, config: PrismaAppConfig, opts: LowerOptions) {
  // A LowerError at deploy is fatal; orDie moves it off the error channel to
  // match what Alchemy.Stack accepts.
  const stackEffect = Effect.orDie(lowering(root, config, opts)) as Effect.Effect<
    LoweredNode,
    never
  >;

  return Alchemy.Stack(
    opts.name,
    { providers: mergedProviders(config), state: resolveStateLayer(opts, config) },
    stackEffect,
  );
}
