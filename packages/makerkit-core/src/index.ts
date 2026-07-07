/**
 * The authoring + control entry: node factories, Load, configOf, and the
 * model types. Imports nothing — bundling a module that uses this entry
 * ships only this code. (/control carves out of here when the control
 * surface grows.) Pure barrel — no implementations live here.
 */

export type {
  ConfigAdapter,
  ConfigDeclaration,
  ConfigParam,
  ConfigRequest,
  Connection,
  Params,
  ParamType,
  TypeOf,
  Values,
} from './config.ts';
export { configOf } from './config.ts';
export type { Edge, Graph, GraphNode, NodeId } from './graph.ts';
export { Load, LoadError } from './graph.ts';
export type {
  Deps,
  Hydrated,
  HydratedDeps,
  NodeBase,
  ResourceNode,
  ServiceHandler,
  ServiceNode,
} from './node.ts';
export { isNode, resource, service } from './node.ts';
