/**
 * The router. Core's only job at deploy: Load (a hex root), then
 * for each node walk the target's lowering tables and run what they find —
 * application once, then per service: resources → provision → build the
 * typed Config → serialize → package → deploy. Deps before dependents,
 * sequenced as Alchemy dependency edges (never statement order — see
 * core-model.md § Lowering). Imports the provisioning substrate
 * (alchemy/effect) — never a deployment target.
 */

import type { StackServices } from 'alchemy';
import * as Alchemy from 'alchemy';
import type { State } from 'alchemy/State/State';
import * as Effect from 'effect/Effect';
import type * as Layer from 'effect/Layer';
import type { Config } from './config.ts';
import { type Graph, Load, type NodeId } from './graph.ts';
import type { BuildAdapter, HexNode, ResourceNode, ServiceNode } from './node.ts';

/** The Layer shape every Alchemy state store must satisfy — what `LowerOptions.state` and `Target.state` both traffic in. */
export type AlchemyStateLayer = Layer.Layer<State, never, StackServices>;

/**
 * What a target pack's /target entry produces — data + per-type SPI
 * functions. The pack is never the actor: these are tools core invokes at
 * moments core chooses; none sees the graph, sequences anything, or calls
 * another.
 */
export interface Target {
  readonly name: string;
  /** The pack's Alchemy providers. */
  providers(): Layer.Layer<never>;
  /** The application's shared infrastructure — runs once, before anything else. */
  readonly application: ApplicationLowering;
  /** Resource type id → one-shot lowering. */
  readonly resources: Record<string, Lowering>;
  /** Service type id → the phased SPI. */
  readonly services: Record<string, ServiceLowering>;
  /** The target's default state backend — every target supplies one (e.g. local state), so a deploy never falls back to a core-owned default; explicit opts.state always wins. */
  readonly state: () => AlchemyStateLayer;
}

/**
 * The application's shared infrastructure: on Prisma Cloud, the one Project
 * (the config namespace and lifecycle boundary) plus the poison DATABASE_URL
 * variables. Its outputs (projectId) reach every later SPI call via
 * LowerContext.application.
 */
export interface ApplicationLowering {
  provision(ctx: LowerContext): Effect.Effect<LoweredNode, unknown, unknown>;
}

/** The phased service SPI — the seam between the phases belongs to CORE. */
export interface ServiceLowering {
  /**
   * Make the target-specific thing that will host the service —
   * identity-bearing infrastructure only (e.g. an App), inside the
   * application's Project; no code runs.
   */
  provision(ctx: LowerContext): Effect.Effect<LoweredNode, unknown, unknown>;
  /**
   * Encode the typed Config core built into the service's runtime
   * environment. The pack owns the encoding; its boot-side deserialize
   * (run) reverses it through the same serializer, so writer and reader
   * cannot drift. Returns the env-var records so `deploy` can reference them
   * (the environment edge — see alchemy-lowering.md).
   */
  serialize(
    ctx: LowerContext,
    provisioned: LoweredNode,
    config: Config,
  ): Effect.Effect<LoweredNode, unknown, unknown>;
  /**
   * Print the bootstrap (address baked in — the whole per-instance
   * deployment parameter) and assemble the deployable artifact from the
   * app-built bundle. MUST be byte-deterministic: identical inputs yield an
   * identical hash, so an unchanged service noops on redeploy.
   */
  package(ctx: LowerContext, input: PackageInput): Effect.Effect<Artifact, unknown, unknown>;
  /**
   * Ship the packaged artifact into the provisioned thing and run it.
   * Consumes `serialized`'s env records via the Deployment's environment
   * prop (the edge). Returns the trustworthy URL.
   */
  deploy(
    ctx: LowerContext,
    provisioned: LoweredNode,
    artifact: Artifact,
    serialized: LoweredNode,
  ): Effect.Effect<LoweredNode, unknown, unknown>;
}

/**
 * The bootstrap the pack prints is the ONLY runnable MakerKit adds. It imports
 * the wrapper and calls run with the address AND a boot thunk that imports the
 * app's built entry (`assembled.entry`) — a printed, literal dynamic import, so
 * no bundler ever follows it.
 */
export interface PackageInput {
  /** The build adapter's normalized output: the bundle dir + the app's runnable. */
  readonly assembled: Bundle;
  /** The node's graph address — baked into the printed bootstrap. */
  readonly address: string;
}

/** One node's realization. Runs inside the Alchemy stack effect. */
export type Lowering = (ctx: LowerContext) => Effect.Effect<LoweredNode, unknown, unknown>;

export interface LowerContext {
  readonly id: NodeId;
  /**
   * The node's deployment address (graph position): its provision id in the
   * hex root. The config-key namespace and the bootstrap parameter.
   */
  readonly address: string;
  readonly node: ServiceNode | ResourceNode;
  readonly graph: Graph;
  readonly opts: LowerOptions;
  /** The application provision's outputs. */
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
  // The interim carrier of assembled bundle dirs (deploy tooling runs each
  // service's build-adapter assembler and drops this map): one bundle per
  // provisioned service, keyed by provision id.
  readonly bundles: Record<string, Bundle>;
  readonly stage?: string;
  /** Alchemy state store for the stack. Defaults to the target's own state layer. */
  readonly state?: AlchemyStateLayer;
}

/**
 * A build adapter's normalized product — and the interim assembled-bundle
 * carrier `LowerOptions.bundles` hands to `package()`: the dir the
 * adapter's assembler produced (wrapper + app entry + fixups) plus the app's
 * runnable entry relative to it (for the bootstrap's boot import). One name,
 * one shape, defined once — every deploy-side package (the CLI, `@makerkit/
 * assemble`, each build adapter's `/assemble`) imports this instead of
 * redeclaring it.
 */
export interface Bundle {
  readonly dir: string;
  readonly entry: string;
}

/**
 * The assembler seam's input — `@makerkit/assemble` and every build adapter's
 * `/assemble` entry (`@makerkit/node`, `@makerkit/nextjs`, …) import this one
 * definition rather than each declaring their own `Assemble(r)Input`.
 */
export interface AssembleInput {
  readonly build: BuildAdapter;
  /**
   * Extra patterns to inline into the wrapper besides `@makerkit/*` — the
   * service module's own imports that are neither shipped in the bundle dir
   * nor runtime built-ins (e.g. the app's workspace packages).
   */
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

/**
 * Deploy-side: assembles the typed Config for one service — each declared
 * input's params matched by name to its producer's lowered outputs, plus
 * service-param defaults. Leaf values are provisioning refs, not strings.
 * Every slot resolves the same way, via its "dependency" edge to whatever
 * the hex wired in: a resource's lowered outputs (shared by every consumer
 * wired to it), or a producer service's deploy outputs (already fully
 * deployed in topo order, so its URL is real — PRO-200).
 */
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

/**
 * The state-layer precedence a deploy resolves to: an explicit opts.state
 * always wins; failing that, the target's own default (every target supplies
 * one). A pure function so the precedence is testable without booting
 * Alchemy.
 */
export function resolveStateLayer(opts: LowerOptions, target: Target): AlchemyStateLayer {
  return opts.state ?? target.state();
}

/**
 * Composable form — for MIXED topologies: MakerKit-authored nodes beside
 * hand-wired Alchemy resources in one stack. Runs the same Load → route walk
 * inside the caller's stack effect and returns the root's LoweredNode, whose
 * outputs (e.g. the deployed URL) hand-wired resources may consume. A hex
 * root has no outputs of its own yet (boundary ports are future work) — its
 * lowering returns `{ outputs: {} }`.
 *
 * Error channel: LowerError from routing, PLUS whatever a pack lowering
 * fails with (their error type is open) — a mixed-stack caller treats
 * failures as deploy-fatal or inspects; it must not assume LowerError is the
 * only inhabitant.
 */
export function lowering(
  root: HexNode,
  target: Target,
  opts: LowerOptions,
): Effect.Effect<LoweredNode, LowerError, unknown> {
  return Effect.gen(function* () {
    const graph = Load(root, { id: opts.name });
    const lowered = new Map<NodeId, LoweredNode>();

    // Every hex-provisioned service's own graph id IS its address (single-
    // level hex only — nesting is out of scope).
    const serviceAddress = new Map<NodeId, string>();
    for (const { id, node } of graph.nodes) {
      if (node.kind === 'service') serviceAddress.set(id, id);
    }

    const appCtx: LowerContext = {
      id: graph.root.id,
      address: '',
      // Not a specific node — application provisioning is graph-wide.
      node: graph.root.node as never,
      graph,
      opts,
      application: { outputs: {} },
      lowered,
    };
    const application = yield* target.application.provision(appCtx);

    for (const { id, node } of graph.nodes) {
      if (node.kind === 'hex') continue; // the transparent root itself — nothing to lower
      // Dependency slots are edges only, never lowered — only hex-provisioned
      // resources and services are.
      if (node.kind === 'dependency') continue;

      const address = serviceAddress.get(id) ?? '';
      const ctx: LowerContext = {
        id,
        address,
        node: node as ServiceNode | ResourceNode,
        graph,
        opts,
        application,
        lowered,
      };

      if (node.kind === 'resource') {
        const lowerResource = target.resources[node.type];
        if (lowerResource === undefined) {
          return yield* Effect.fail(
            new LowerError(
              `Target "${target.name}" has no resource lowering for type "${node.type}" ` +
                `(known: ${Object.keys(target.resources).join(', ')}).`,
            ),
          );
        }
        lowered.set(id, yield* lowerResource(ctx));
        continue;
      }

      const serviceLowering = target.services[node.type];
      if (serviceLowering === undefined) {
        return yield* Effect.fail(
          new LowerError(
            `Target "${target.name}" has no service lowering for type "${node.type}" ` +
              `(known: ${Object.keys(target.services).join(', ')}).`,
          ),
        );
      }

      const provisioned = yield* serviceLowering.provision(ctx);
      const config = buildConfig(node as ServiceNode, id, graph, lowered);
      const serialized = yield* serviceLowering.serialize(ctx, provisioned, config);
      const bundle = opts.bundles[id];
      if (bundle === undefined) {
        return yield* Effect.fail(missingBundleError(id));
      }
      const artifact = yield* serviceLowering.package(ctx, {
        assembled: { dir: bundle.dir, entry: bundle.entry },
        address,
      });
      lowered.set(id, yield* serviceLowering.deploy(ctx, provisioned, artifact, serialized));
    }

    return { outputs: {} };
  }) as Effect.Effect<LoweredNode, LowerError, unknown>;
}

/**
 * The whole-stack wrapper: Load → route each node through the target's
 * tables → an Alchemy Stack (the default export the alchemy CLI consumes).
 */
export function lower(root: HexNode, target: Target, opts: LowerOptions) {
  // A LowerError at deploy is fatal; orDie moves it off the error channel so
  // the stack effect matches what Alchemy.Stack accepts. The requirements
  // channel is `unknown` by design (the pack's lowerings carry their own
  // provider requirements, satisfied by target.providers()); the assertion
  // narrows it for Stack's inference.
  const stackEffect = Effect.orDie(lowering(root, target, opts)) as Effect.Effect<
    LoweredNode,
    never
  >;

  return Alchemy.Stack(
    opts.name,
    { providers: target.providers(), state: resolveStateLayer(opts, target) },
    stackEffect,
  );
}
