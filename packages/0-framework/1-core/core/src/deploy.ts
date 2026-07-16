/** Routes each graph node to its extension descriptor (by node.extension/type) and runs provision → serialize → package → deploy in dependency order. */

import type { StackServices } from 'alchemy';
import * as Alchemy from 'alchemy';
import type { State } from 'alchemy/State/State';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import type { ExtensionDescriptor, NodeDescriptor, PrismaAppConfig } from './app-config.ts';
import type { Config } from './config.ts';
import { type Graph, Load, type NodeId } from './graph.ts';
import type { BuildAdapter, ModuleNode, ProvisionNeed, ResourceNode, ServiceNode } from './node.ts';

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

/**
 * One provisioned param need, resolved against the CONSUMER extension's
 * `provisions` registry (ADR-0031). `edgeId` — `${consumerAddress}.${input}`
 * — is the mint's stable resource key, so a provisioner's own resource ids
 * derive from it and stay stable across redeploys.
 */
export interface ProvisionEdge {
  readonly edgeId: string;
  readonly consumerAddress: string;
  readonly providerAddress: string;
  readonly input: string;
  /** Opaque; forwarded from the param's declared need. Core never reads its payload. */
  readonly need: ProvisionNeed;
}

/** One extension-registered provisioner, keyed by a need's brand (ADR-0031). */
export interface ProvisionerDescriptor {
  /** Mints one stable value for one provisioned edge; yields the platform resource, returns an opaque ref core forwards into config. */
  provision(edge: ProvisionEdge): Effect.Effect<unknown, unknown, unknown>;
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
  /** Every provisioned param value minted this lowering, keyed by edge id (ADR-0031). */
  readonly provisioned: ReadonlyMap<string, unknown>;
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
  /** Extra patterns to inline into the wrapper besides `@prisma/composer*` (e.g. the app's own workspace packages). */
  readonly wrapperNoExternal?: readonly RegExp[];
  /** The service's graph address (e.g. "storefront.web"). Unique per service, so the assembler uses it to name this service's own working directory: `<cwd>/.prisma-composer/artifacts/<address>/`. */
  readonly address: string;
  /** The directory the deploy command was run from. The assembler puts its working directory under it (`<cwd>/.prisma-composer/`), the same place the CLI writes its other generated files. */
  readonly cwd: string;
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

/**
 * Assembles a service's typed Config from its dependency edges' lowered
 * outputs plus its own param defaults. A param carrying a `provision` need
 * (ADR-0031) sources its value from `provisioned` (keyed by edge id) instead
 * of the producer's outputs — the framework mints it, the producer hands
 * nothing over.
 */
export function buildConfig(
  node: ServiceNode,
  id: NodeId,
  graph: Graph,
  lowered: ReadonlyMap<NodeId, LoweredNode>,
  provisioned: ReadonlyMap<string, unknown>,
): Config {
  const inputs: Record<string, Record<string, unknown>> = {};

  for (const [inputName, inputNode] of Object.entries(node.inputs)) {
    const edge = graph.edges.find(
      (e) => e.to === id && e.input === inputName && e.kind === 'dependency',
    );
    const producedOutputs = edge !== undefined ? (lowered.get(edge.from)?.outputs ?? {}) : {};
    const values: Record<string, unknown> = {};
    for (const [name, param] of Object.entries(inputNode.connection.params)) {
      values[name] =
        param.provision !== undefined
          ? provisioned.get(`${id}.${inputName}`)
          : producedOutputs[name];
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
      "prisma-composer.config.ts's `extensions` (import its /control entry and list its descriptor).",
  );
}

function unknownNodeTypeError(extension: ExtensionDescriptor, type: string): LowerError {
  return new LowerError(
    `Extension "${extension.id}" has no descriptor for node type "${type}" ` +
      `(known: ${Object.keys(extension.nodes).join(', ')}).`,
  );
}

/** A provisioned param's need brand isn't registered by the consumer's extension (ADR-0031). */
function unknownProvisionerError(
  extension: ExtensionDescriptor,
  brand: symbol,
  edgeId: string,
): LowerError {
  const known =
    extension.provisions !== undefined && extension.provisions.size > 0
      ? Array.from(extension.provisions.keys(), String).join(', ')
      : '(none registered)';
  return new LowerError(
    `Extension "${extension.id}" has no provisioner for need "${String(brand)}" ` +
      `(needed by edge "${edgeId}") (known: ${known}).`,
  );
}

/** A provisioned edge whose consumer and provider nodes belong to different extensions (ADR-0031). */
function crossExtensionProvisionError(edgeId: string): LowerError {
  return new LowerError(
    `Provisioned edge "${edgeId}" spans two extensions — cross-extension provisioned edges ` +
      "aren't supported yet.",
  );
}

/**
 * More than one provisioned param on one connection (ADR-0031). One edge mints
 * ONE value, keyed by edge id, so a second need on the same connection would
 * silently receive the first's value under the first's brand.
 */
function multipleProvisionedParamsError(edgeId: string, names: readonly string[]): LowerError {
  return new LowerError(
    `Connection input "${edgeId}" declares more than one provisioned param ` +
      `(${names.join(', ')}) — only one provisioned param per connection is supported.`,
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
    // ADR-0031: every provisioned param value minted this lowering, keyed by
    // edge id. Populated by the provision phase below (after the application
    // hooks, before any node), then threaded read-only through every ctx and
    // into buildConfig — the same declare-then-mutate idiom as `lowered`.
    const provisioned = new Map<string, unknown>();

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
        provisioned,
      };
      applications.set(descriptor.id, yield* descriptor.application.provision(appCtx));
    }

    // ADR-0031: resolve every provisioned param's need against its CONSUMER
    // node's extension, mint the edge's value once, and store it — before any
    // node is lowered, since a provider's own provision() may already need its
    // inbound provisioned edges (e.g. RPC's accepted-key set).
    for (const edge of graph.edges) {
      if (edge.kind !== 'dependency') continue;
      const consumer = graph.nodes.find((n) => n.id === edge.to)?.node;
      if (consumer === undefined || consumer.kind !== 'service') continue;
      const slot = consumer.inputs[edge.input];
      if (slot === undefined) continue;
      const provisionedParams = Object.entries(slot.connection.params).filter(
        ([, param]) => param.provision !== undefined,
      );
      if (provisionedParams.length === 0) continue;

      const edgeId = `${edge.to}.${edge.input}`;
      // One edge mints ONE value (keyed by edgeId), and buildConfig hands it to
      // every provisioned param on the connection — so a second need here would
      // silently take the first's value under the first's brand. Fail instead.
      if (provisionedParams.length > 1) {
        return yield* Effect.fail(
          multipleProvisionedParamsError(
            edgeId,
            provisionedParams.map(([name]) => name),
          ),
        );
      }
      const need = provisionedParams[0]?.[1].provision;
      if (need === undefined) continue;

      const provider = graph.nodes.find((n) => n.id === edge.from)?.node;
      if (provider === undefined || (provider.kind !== 'service' && provider.kind !== 'resource')) {
        continue; // a dependency edge's producer is always a provisioned resource/service
      }
      if (consumer.extension !== provider.extension) {
        return yield* Effect.fail(crossExtensionProvisionError(edgeId));
      }
      const extension = extensions.get(consumer.extension);
      if (extension === undefined) {
        return yield* Effect.fail(unknownExtensionError(consumer.extension, edge.to));
      }
      const provisioner = extension.provisions?.get(need.brand);
      if (provisioner === undefined) {
        return yield* Effect.fail(unknownProvisionerError(extension, need.brand, edgeId));
      }
      const ref = yield* provisioner.provision({
        edgeId,
        consumerAddress: edge.to,
        providerAddress: edge.from,
        input: edge.input,
        need,
      });
      provisioned.set(edgeId, ref);
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
        provisioned,
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
      // Named distinctly from the outer `provisioned` map (ADR-0031's minted
      // param values, keyed by edge id) — this is the per-node provision()
      // result (e.g. the ComputeService a node is placed into).
      const provisionedNode = yield* descriptor.provision(ctx);
      const typedConfig = buildConfig(service, id, graph, lowered, provisioned);
      const serialized = yield* descriptor.serialize(ctx, provisionedNode, typedConfig);
      const bundle = opts.bundles[id];
      if (bundle === undefined) {
        return yield* Effect.fail(missingBundleError(id));
      }
      const artifact = yield* descriptor.package(ctx, {
        assembled: { dir: bundle.dir, entry: bundle.entry },
        address: id,
      });
      lowered.set(id, yield* descriptor.deploy(ctx, provisionedNode, artifact, serialized));
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
