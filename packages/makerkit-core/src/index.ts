/**
 * The authoring + control entry: node factories, Load, configOf, and the
 * model types. Imports nothing — bundling a module that uses this entry
 * ships only this code. (/control carves out of here when the control
 * surface grows.) Pure barrel — no implementations live here.
 */
export { resource, service, isNode } from "./node.ts";
export type {
  NodeBase,
  ResourceNode,
  ServiceNode,
  Deps,
  Hydrated,
  HydratedDeps,
  ServiceHandler,
} from "./node.ts";

export { Load, LoadError } from "./graph.ts";
export type { NodeId, GraphNode, Edge, Graph } from "./graph.ts";

export { configOf } from "./config.ts";
export type {
  ParamType,
  TypeOf,
  ConfigParam,
  Params,
  Values,
  Connection,
  ConfigAdapter,
  ConfigRequest,
  ConfigManifestEntry,
} from "./config.ts";
