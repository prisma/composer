/**
 * The router. Core's only job at deploy: Load, then look up each node's
 * `type` in the target's lowering table and run what it finds, deps before
 * dependents. Imports the provisioning substrate (alchemy/effect) — never a
 * deployment target.
 */
import * as Alchemy from "alchemy";
import type { StackServices } from "alchemy";
import { localState } from "alchemy/State/LocalState";
import type { State } from "alchemy/State/State";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import { Load, type Graph, type NodeId } from "./graph.ts";
import type { ResourceNode, ServiceNode } from "./node.ts";

/** What a target pack's /target entry produces — data + per-type functions. */
export interface Target {
  readonly name: string;
  /** The pack's Alchemy providers. */
  providers(): Layer.Layer<never>;
  /** Type id → lowering. */
  readonly lower: Record<string, Lowering>;
}

/**
 * One node's realization. Runs inside the Alchemy stack effect; yields the
 * pack's Alchemy resources. Core never looks inside.
 */
export type Lowering = (ctx: LowerContext) => Effect.Effect<LoweredNode, unknown, unknown>;

export interface LowerContext {
  readonly id: NodeId;
  readonly node: ServiceNode | ResourceNode;
  readonly graph: Graph;
  readonly opts: LowerOptions;
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
  /** App-built bundle — the artifact is an input, not a product. */
  readonly artifact: { readonly path: string; readonly sha256: string };
  readonly stage?: string;
  /** Alchemy state store for the stack. Defaults to local state. */
  readonly state?: Layer.Layer<State, never, StackServices>;
}

export class LowerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LowerError";
  }
}

/**
 * Composable form — for mixed topologies: MakerKit-authored nodes beside
 * hand-wired Alchemy resources in one stack. Runs the Load → route walk
 * inside the caller's stack effect and returns the root's LoweredNode, whose
 * outputs hand-wired resources may consume.
 */
export function lowering(
  root: ServiceNode,
  target: Target,
  opts: LowerOptions,
): Effect.Effect<LoweredNode, LowerError, unknown> {
  return Effect.gen(function* () {
    const graph = Load(root, { id: opts.name });
    const lowered = new Map<NodeId, LoweredNode>();

    for (const { id, node } of graph.nodes) {
      const lowerNode = target.lower[node.type];
      if (lowerNode === undefined) {
        return yield* Effect.fail(
          new LowerError(
            `Target "${target.name}" has no lowering for node type "${node.type}" ` +
              `(known types: ${Object.keys(target.lower).join(", ")}).`,
          ),
        );
      }
      const result = yield* lowerNode({ id, node, graph, opts, lowered });
      lowered.set(id, result as LoweredNode);
    }

    return lowered.get(graph.root.id) as LoweredNode;
  }) as Effect.Effect<LoweredNode, LowerError, unknown>;
}

/**
 * The whole-stack wrapper: Load → route each node through
 * target.lower[node.type] → an Alchemy Stack (the default export the alchemy
 * CLI consumes).
 */
export function lower(root: ServiceNode, target: Target, opts: LowerOptions) {
  // A LowerError at deploy is fatal; orDie moves it off the error channel so
  // the stack effect matches what Alchemy.Stack accepts. The requirements
  // channel is `unknown` by design (the pack's lowerings carry their own
  // provider requirements, satisfied by target.providers()); the assertion
  // narrows it for Stack's inference.
  const stackEffect = Effect.orDie(lowering(root, target, opts)) as Effect.Effect<LoweredNode, never>;

  return Alchemy.Stack(
    opts.name,
    { providers: target.providers(), state: opts.state ?? localState() },
    stackEffect,
  );
}
