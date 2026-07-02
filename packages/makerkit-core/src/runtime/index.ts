/**
 * The dumb loop. Symmetric to lowering: look up each input's `type` in the
 * target's hydrator table, then call the user handler. Imports nothing.
 */
import { Load, type NodeId } from "../graph.ts";
import type { ResourceNode, RuntimeContext, ServiceNode } from "../node.ts";

export type Env = Record<string, string | undefined>;

export interface TargetRuntime {
  /** Type id → hydrator. */
  readonly hydrate: Record<string, Hydrator>;
  /** Platform convention lives in the pack — e.g. PORT → { port }. */
  context(env: Env): RuntimeContext;
}

export type Hydrator = (ctx: HydrateContext) => unknown;

export interface HydrateContext {
  readonly id: NodeId;
  /** The input name, e.g. "db". */
  readonly input: string;
  readonly node: ResourceNode;
  readonly env: Env;
}

export class HydrateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HydrateError";
  }
}

// The ambient environment of whatever runtime hosts the bundle. Declared
// structurally so this entry imports no runtime's types.
declare const process: { readonly env: Env };

/**
 * Load(root) → hydrate each input via runtime.hydrate[node.type] →
 * root.run(hydratedDeps, runtime.context(env)). Load runs before any
 * hydration — wiring precedes execution, mechanically. This default `env`
 * parameter is the only place the ambient environment enters the system; it
 * is handed straight to the target's hydrators/context.
 */
export function runHost(root: ServiceNode, runtime: TargetRuntime, env: Env = process.env): unknown {
  const graph = Load(root);

  const byId = new Map(graph.nodes.map((entry) => [entry.id, entry]));
  const deps: Record<string, unknown> = {};

  for (const edge of graph.edges) {
    const entry = byId.get(edge.from);
    if (entry === undefined || entry.node.kind !== "resource") {
      throw new HydrateError(`Edge "${edge.from}" does not point at a resource node.`);
    }
    const hydrator = runtime.hydrate[entry.node.type];
    if (hydrator === undefined) {
      throw new HydrateError(
        `Runtime has no hydrator for node type "${entry.node.type}" ` +
          `(known types: ${Object.keys(runtime.hydrate).join(", ")}).`,
      );
    }
    deps[edge.input] = hydrator({ id: entry.id, input: edge.input, node: entry.node, env });
  }

  return root.run(deps as Parameters<typeof root.run>[0], runtime.context(env));
}
