/**
 * The authoring + control entry: node factories, Load, configOf, hydrate,
 * and the model types. Imports nothing — bundling a module that uses this
 * entry ships only this code. (/control carves out of here when the control
 * surface grows.) Pure barrel — no implementations live here.
 */

export type {
  Config,
  ConfigDeclaration,
  ConfigParam,
  Connection,
  Params,
  Values,
} from './config.ts';
export { configOf, number, param, string } from './config.ts';
export type { Contract } from './contract.ts';
export type { Edge, Graph, GraphNode, NodeId } from './graph.ts';
export { Load, LoadError } from './graph.ts';
export { hydrate, hydrateSync } from './hydrate.ts';
export type {
  BuildAdapter,
  DependencyEnd,
  Deps,
  Expose,
  Hydrated,
  HydratedDeps,
  InputRef,
  ProvisionedRef,
  RefPort,
  ResourceNode,
  RunnableServiceNode,
  ServiceNode,
  SystemBuilder,
  SystemContext,
  SystemNode,
  SystemOutputs,
} from './node.ts';
export { dependency, isNode, resource, service, system } from './node.ts';
