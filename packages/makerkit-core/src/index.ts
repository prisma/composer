/**
 * The authoring entry: node factories, Load, and the model types. Imports
 * nothing — bundling a module that uses this entry ships only this code.
 */
export { resource, service, isNode } from "./node.ts";
export type {
  JsonValue,
  JsonObject,
  NodeBase,
  ResourceNode,
  ServiceNode,
  Deps,
  Hydrated,
  HydratedDeps,
  RuntimeContext,
  ServiceHandler,
} from "./node.ts";

export { Load, LoadError } from "./graph.ts";
export type { NodeId, GraphNode, Edge, Graph } from "./graph.ts";
