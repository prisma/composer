/** Routes each graph node to its extension descriptor (by node.extension/type) and runs provision → serialize → package → deploy in dependency order. */

import type { Input, StackServices } from 'alchemy';
import * as Alchemy from 'alchemy';
import type { State } from 'alchemy/State/State';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import type { Config, ConfigParam } from '../config.ts';
import { type Graph, Load, type NodeId } from '../graph.ts';
import {
  type BuildAdapter,
  isParamSource,
  type ModuleNode,
  type ProvisionNeed,
  type ResourceNode,
  type ServiceNode,
} from '../node.ts';
import type { ExtensionDescriptor, NodeDescriptor, PrismaAppConfig } from './app-config.ts';

/** The Layer shape every Alchemy state store must satisfy — what `LowerOptions.state` and `PrismaAppConfig.state` both traffic in. */
export type AlchemyStateLayer = Layer.Layer<State, never, StackServices>;

/**
 * An extension's application-level descriptor: shared infrastructure that runs
 * once per lowering, before any node. Its outputs reach the extension's own
 * SPI calls via LowerContext.application.
 */
export interface ApplicationDescriptor {
  provision(ctx: LowerContext): Effect.Effect<unknown, unknown, unknown>;
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

/**
 * The phased service SPI. `P` and `S` are the descriptor's OWN intra-node
 * handoff types — provision's product consumed by serialize/deploy, and
 * serialize's product consumed by deploy. Core threads them through without
 * inspection; only the descriptor that writes them reads them.
 *
 * Method syntax (not property-arrow) is required: the heterogeneous
 * descriptor registry (`NodeDescriptor`) assigns concrete descriptors to
 * this interface's `unknown` defaults through TypeScript's method
 * bivariance — a property-arrow form is checked contravariantly and breaks
 * that assignment.
 */
export interface ServiceLowering<P = unknown, S = unknown> {
  /** Makes the platform-specific thing that will host the service — identity-bearing infrastructure only, no code runs. */
  provision(ctx: LowerContext): Effect.Effect<P, unknown, unknown>;
  /**
   * Encodes the typed Config into the service's runtime environment. Boot-side
   * deserialize reverses it through the same serializer. Returns the env-var
   * records so `deploy` can reference them.
   */
  serialize(ctx: LowerContext, provisioned: P, config: Config): Effect.Effect<S, unknown, unknown>;
  /**
   * Prints the bootstrap and assembles the deployable artifact from the
   * app-built bundle. Must be byte-deterministic: an unchanged service noops
   * on redeploy.
   */
  package(ctx: LowerContext, input: PackageInput): Effect.Effect<Artifact, unknown, unknown>;
  /** Ships the packaged artifact into the provisioned thing and runs it. Returns the node's outputs for dependents, plus the entities it became on the deployment target. */
  deploy(
    ctx: LowerContext,
    provisioned: P,
    artifact: Artifact,
    serialized: S,
  ): Effect.Effect<LoweredResult, unknown, unknown>;
}

/** Input to an extension's package() step: the built bundle and the node's graph address. */
export interface PackageInput {
  /** The build descriptor's normalized output: the bundle dir + the app's runnable. */
  readonly assembled: Bundle;
  /** The node's graph address — baked into the printed bootstrap. */
  readonly address: string;
}

/** One node's realization. Runs inside the Alchemy stack effect. */
export type Lowering = (ctx: LowerContext) => Effect.Effect<LoweredResult, unknown, unknown>;

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
  /**
   * The owning extension's application hook product; `undefined` when the
   * extension declares no hook. Core never reads it; the extension narrows
   * it with its own type guard.
   */
  readonly application: unknown;
  /** Already-lowered deps (topo order). */
  readonly lowered: ReadonlyMap<NodeId, Outputs>;
  /** Every provisioned param value minted this lowering, keyed by edge id (ADR-0031). */
  readonly provisioned: ReadonlyMap<string, unknown>;
}

/**
 * The values a node provides to its dependents — what a consumer's declared
 * connection params resolve against (buildConfig reads them by param name).
 * Name-keyed and unknown-valued of necessity: core cannot know extension
 * types, and which producer feeds which consumer is decided by the user's
 * graph at runtime. The connection declaration is the contract.
 */
export type Outputs = Readonly<Record<string, unknown>>;

/**
 * One thing a node became on the deployment target, RESOLVED — what the report
 * consumer sees. The descriptor names it; core never infers meaning from it.
 * `url` is present ONLY when the descriptor declares the address publicly
 * reachable — a connection string is never a `url`.
 *
 * A descriptor constructing one holds `svc.id` / `deployment.deployedUrl` —
 * `Output<T>` references, not values, because the stack effect runs before
 * Alchemy applies anything. So construction sites traffic in
 * `Input<DeployedEntity>` (Alchemy's own idiom for "this shape, fields possibly
 * unresolved"); apply resolves it before any reader sees it.
 */
export interface DeployedEntity {
  readonly kind: string;
  readonly id: string;
  readonly url?: string;
  readonly details?: Readonly<Record<string, string>>;
}

/**
 * What a node's final lowering phase produces: outputs for dependents,
 * entities for reporting.
 *
 * `entities` is REQUIRED, not optional. "This node became nothing reportable
 * on the deployment target" is a claim, and an optional field lets a
 * descriptor make it by saying nothing at all — no error, no type complaint,
 * no failing test. That is the shared bag's sin in miniature (ADR-0033): a
 * claim made anonymously, with nothing recording that a claim was made. `[]`
 * costs one token and puts the assertion on the record where a reviewer can
 * see it.
 */
export interface LoweredResult {
  readonly outputs: Outputs;
  readonly entities: readonly Input<DeployedEntity>[];
}

/** What one graph node became — in-process only (it holds the node itself, so it never crosses the stack boundary). */
export interface DeployedNode {
  readonly address: string;
  readonly node: ServiceNode | ResourceNode;
  readonly entities: readonly DeployedEntity[];
}

/** The result of the Deploy operation: the app and every node it deployed, in topo order. */
export interface DeploymentResult {
  readonly app: string;
  readonly nodes: readonly DeployedNode[];
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
  /**
   * Invoked once per deploy, during apply, with the Deploy operation's result
   * — the app and every node it deployed, resolved, in topo order.
   * Presentation belongs to the caller (the CLI wires its renderer here);
   * core never formats. Absent means no report is assembled and no Action is
   * declared at all.
   */
  readonly report?: (result: DeploymentResult) => void;
}

/** A build descriptor's normalized output: the produced bundle dir plus the app's runnable entry within it. */
export interface Bundle {
  readonly dir: string;
  readonly entry: string;
}

/** Shared input shape for every extension's build descriptor. */
export interface AssembleInput {
  readonly build: BuildAdapter;
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
 * Resolves one SERVICE-OWN param to its config value. The full resolution
 * order across both value channels:
 *
 * 1. A param claiming BOTH a provision-time binding and a `provision` need
 *    (ADR-0031) is a loud error — two sources for one value.
 * 2. A provision-time binding (a schema-validated literal, or an opaque
 *    `ParamSource` the target resolves at boot per ADR-0019) beats the
 *    declared `default`.
 * 3. A framework-minted `provision` need is resolved per dependency EDGE
 *    against the consumer extension's registry — that path fills CONNECTION
 *    params in `buildConfig`'s inputs loop, never this function. A
 *    service-own param has no edge to mint against, so an unbound need here
 *    falls through like any unbound param.
 * 4. The `default`, else absent (only legal when `optional`), else a loud
 *    error naming the param, the service, and the fix.
 */
function resolveParam(
  node: ServiceNode,
  serviceId: NodeId,
  name: string,
  param: ConfigParam,
  bound: unknown,
): unknown {
  if (bound !== undefined) {
    if (param.provision !== undefined) {
      throw new LowerError(
        `Param "${name}" of "${serviceId}" (service "${node.name}") has two sources claiming one ` +
          `value: a provision-time binding (${isParamSource(bound) ? 'a param source' : 'a literal value'}) ` +
          `AND a framework provision need ("${String(param.provision.brand)}") on its declaration — ` +
          'remove the binding or drop the `provision` facet.',
      );
    }
    if (isParamSource(bound)) return bound;
    const result = param.schema['~standard'].validate(bound);
    if (result instanceof Promise) {
      throw new LowerError(
        `Param "${name}" of "${serviceId}" (service "${node.name}") uses an async Standard Schema — ` +
          'a provision-time literal value requires a synchronous validator.',
      );
    }
    if (result.issues !== undefined) {
      const messages = result.issues.map((issue) => issue.message).join('; ');
      throw new LowerError(
        `Param "${name}" of "${serviceId}" (service "${node.name}") received an invalid ` +
          `provision-time value: ${messages}`,
      );
    }
    return result.value;
  }
  if (param.default !== undefined) return param.default;
  if (param.optional === true) return undefined;
  throw new LowerError(
    `Param "${name}" of "${serviceId}" (service "${node.name}") has no default, is not optional, ` +
      'and was not bound at provision — bind it with a literal value or a param source ' +
      "(e.g. envParam('NAME')) on its provision() call, or give it a default.",
  );
}

/**
 * Assembles a service's typed Config. Connection params come from the
 * dependency edge's lowered outputs — or, for a param carrying a `provision`
 * need (ADR-0031), from `provisioned` (keyed by edge id): the framework mints
 * it, the producer hands nothing over. The service's own params resolve via
 * `resolveParam` (provision-time binding, then default, then loud
 * unbound-required failure).
 *
 * This is also where the connection contract is enforced: a producer that fails to
 * supply a required param its consumer's connection declares fails the deploy
 * here, naming the edge, rather than reaching the consumer as `undefined`.
 */
export function buildConfig(
  node: ServiceNode,
  id: NodeId,
  graph: Graph,
  lowered: ReadonlyMap<NodeId, Outputs>,
  provisioned: ReadonlyMap<string, unknown>,
): Config {
  const inputs: Record<string, Record<string, unknown>> = {};

  for (const [inputName, inputNode] of Object.entries(node.inputs)) {
    const edge = graph.edges.find(
      (e) => e.to === id && e.input === inputName && e.kind === 'dependency',
    );
    const producedOutputs = edge !== undefined ? (lowered.get(edge.from) ?? {}) : {};
    const values: Record<string, unknown> = {};
    for (const [name, param] of Object.entries(inputNode.connection.params)) {
      // ADR-0031: the framework mints this value; the producer hands nothing
      // over, so the connection contract below doesn't apply to it.
      if (param.provision !== undefined) {
        values[name] = provisioned.get(`${id}.${inputName}`);
        continue;
      }

      const value = producedOutputs[name];
      // The connection contract: the consumer's connection declaration says what it
      // needs, and the producer must supply it (ADR-0033). Under-delivery used
      // to reach the consumer as a silent `undefined`, serialized into its
      // environment and failing at ITS boot — far from the mistake.
      //
      // PRESENCE ONLY — deliberately not schema-validated, and it cannot be.
      // At lowering time these values are routinely alchemy `Output` proxies
      // (e.g. `deployment.deployedUrl`): lazy symbolic references that only
      // resolve when Alchemy applies the stack, which is strictly after this
      // whole effect runs. No Standard Schema can validate one. Checking that
      // a value EXISTS is the most that can honestly be checked here.
      //
      // `=== undefined` (not `name in producedOutputs`): a producer explicitly
      // writing `undefined` has supplied nothing, matching resolveParam.
      // `edge === undefined` is left alone — with no producer there is nobody
      // to hold to the contract; an unwired input is a graph concern.
      if (value === undefined && param.optional !== true && edge !== undefined) {
        throw new LowerError(
          `Connection input "${id}.${inputName}" declares param "${name}", but its producer ` +
            `"${edge.from}" did not supply it — the producer's outputs carry ` +
            `[${Object.keys(producedOutputs).join(', ') || 'nothing'}]. Add "${name}" to the ` +
            'outputs the producer returns from its lowering, or declare the param optional on the connection.',
        );
      }
      values[name] = value;
    }
    inputs[inputName] = values;
  }

  const boundParams = new Map(
    graph.params.filter((binding) => binding.serviceAddress === id).map((b) => [b.slot, b.binding]),
  );
  const service: Record<string, unknown> = {};
  for (const [name, param] of Object.entries(node.params)) {
    const value = resolveParam(node, id, name, param, boundParams.get(name));
    if (value !== undefined) service[name] = value;
  }

  return { service, inputs };
}

/**
 * Joins resolved report entries back to their graph nodes — the last step of a
 * deploy report, run inside the Action with apply's resolved values.
 *
 * The entries cross Alchemy's action-input boundary, so they carry addresses
 * and plain entities only; the graph is held by closure on this side. That
 * split is why this join exists at all, and it is what keeps functions and
 * Standard Schemas (which a node carries, and which the plan's input hash
 * would have to serialize) out of the input.
 *
 * Skips an address the graph no longer holds: entries are data, the graph is
 * truth.
 */
export function joinDeployment(
  graph: Graph,
  entries: readonly { address: string; entities: readonly DeployedEntity[] }[],
): readonly DeployedNode[] {
  const nodes: DeployedNode[] = [];
  for (const entry of entries) {
    const found = graph.nodes.find((n) => n.id === entry.address);
    const node = found?.node;
    if (node === undefined || (node.kind !== 'service' && node.kind !== 'resource')) continue;
    nodes.push({ address: entry.address, node, entities: entry.entities });
  }
  return nodes;
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
 * The deployment-report Action's input, declared in RESOLVED terms — this is
 * what the runner receives. The call site passes `Input<DeployedEntity>`s,
 * whose fields may still be `Output` references; alchemy's deep `Input<>`
 * mapping on the input position accepts them and apply resolves them before
 * the runner runs. Addresses and entities only — never graph nodes (see
 * joinDeployment).
 */
interface ReportEntry {
  readonly address: string;
  readonly entities: readonly DeployedEntity[];
}
interface ReportInput {
  readonly nonce: number;
  readonly entries: readonly ReportEntry[];
}

/**
 * Composable form for mixed stacks: hand-wired Alchemy resources alongside Prisma App nodes in one stack effect.
 * Fails with LowerError or whatever an extension's lowering raises — the error type is open.
 */
export function lowering(
  root: ModuleNode,
  config: PrismaAppConfig,
  opts: LowerOptions,
): Effect.Effect<undefined, LowerError, unknown> {
  return Effect.gen(function* () {
    const graph = Load(root, { id: opts.name });
    const extensions = yield* extensionsById(config);
    const lowered = new Map<NodeId, Outputs>();
    // Each node's reported entities, in topo order — the loop is the only
    // party that holds both the node's identity and what it became. Collected
    // unconditionally (it is a cheap array); only the Action below is
    // conditional.
    const entries: { address: string; entities: readonly Input<DeployedEntity>[] }[] = [];
    // ADR-0031: every provisioned param value minted this lowering, keyed by
    // edge id. Populated by the provision phase below (after the application
    // hooks, before any node), then threaded read-only through every ctx and
    // into buildConfig — the same declare-then-mutate idiom as `lowered`.
    const provisioned = new Map<string, unknown>();

    // Each extension's application hook runs ONCE, before any node, in config
    // order — its outputs reach that extension's own nodes via ctx.application
    // (the same threading the one-target model had).
    const applications = new Map<string, unknown>();
    for (const descriptor of config.extensions) {
      if (descriptor.application === undefined) continue;
      const appCtx: LowerContext = {
        id: graph.root.id,
        address: '',
        // Not a specific node — application provisioning is graph-wide.
        node: graph.root.node as never,
        graph,
        opts,
        application: undefined,
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
        application: applications.get(node.extension),
        lowered,
        provisioned,
      };

      const descriptor = yield* descriptorFor(extensions, node, id);

      if (descriptor.kind === 'resource') {
        const result = yield* descriptor(ctx);
        lowered.set(id, result.outputs);
        entries.push({ address: id, entities: result.entities });
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
      const result = yield* descriptor.deploy(ctx, provisionedNode, artifact, serialized);
      lowered.set(id, result.outputs);
      entries.push({ address: id, entities: result.entities });
    }

    // The report is assembled ONLY when a caller asked for one. This
    // conditionality is required, not an optimization: without it every
    // `lowering()` call would declare an Action and drag alchemy's Stack
    // context into core's sync unit tests.
    if (opts.report !== undefined) {
      const report = opts.report;
      const ReportAction = Alchemy.Action('composer-deployment-report', (input: ReportInput) =>
        Effect.sync(() => {
          // `input` arrives RESOLVED — apply evaluates the action's input
          // against its tracker before invoking the runner, so the ids and
          // URLs the descriptors handed over as Output references are real
          // strings here. The graph rides in on the closure, never in the
          // input: the plan hashes the resolved input, and a node carries
          // functions and Standard Schemas.
          report({ app: opts.name, nodes: joinDeployment(graph, input.entries) });
        }),
      );
      // `Date.now()` forces the report to run on an otherwise unchanged
      // redeploy: alchemy noops an action whose resolved input hashes to what
      // the last run persisted. A nonce is legitimate here because this input
      // triggers a report — it is not artifact input, which determinism rules
      // govern.
      yield* ReportAction({ nonce: Date.now(), entries });
    }

    return undefined;
  }) as Effect.Effect<undefined, LowerError, unknown>;
}

/**
 * The whole-stack wrapper: Load → route each node through the config's
 * extension registries → an Alchemy Stack (the default export the alchemy
 * CLI consumes).
 */
export function lower(root: ModuleNode, config: PrismaAppConfig, opts: LowerOptions) {
  // A LowerError at deploy is fatal; orDie moves it off the error channel to
  // match what Alchemy.Stack accepts.
  const stackEffect = Effect.orDie(lowering(root, config, opts)) as Effect.Effect<undefined, never>;

  return Alchemy.Stack(
    opts.name,
    { providers: mergedProviders(config), state: resolveStateLayer(opts, config) },
    stackEffect,
  );
}
