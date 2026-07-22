/**
 * The authoring + control entry: node factories, Load, configOf, hydrate,
 * and the model types. Imports nothing — bundling a module that uses this
 * entry ships only this code. (/control carves out of here when the control
 * surface grows.) Pure barrel — no implementations live here.
 */

export type { SecretString } from '@internal/foundation/secret';
export { SecretBox } from '@internal/foundation/secret';
export type {
  Config,
  ConfigDeclaration,
  ConfigParam,
  Connection,
  Params,
  Values,
} from '../config.ts';
export { configOf, number, param, paramManifest, provisionManifest, string } from '../config.ts';
export type { Contract } from '../contract.ts';
export type { Edge, Graph, GraphNode, NodeId, ParamBinding, SecretBinding } from '../graph.ts';
export { Load, LoadError } from '../graph.ts';
export { hydrate, hydrateSecrets, hydrateSync } from '../hydrate.ts';
export type {
  BuildAdapter,
  DependencyEnd,
  Deps,
  Expose,
  Hydrated,
  HydratedDeps,
  InputRef,
  ModuleBuilder,
  ModuleContext,
  ModuleNode,
  ModuleOutputs,
  NODE,
  ParamBindings,
  ParamNeed,
  ParamNeedBindings,
  ParamNeeds,
  ParamSource,
  ProvisionedRef,
  ProvisionNeed,
  RefPort,
  ResourceNode,
  RunnableServiceNode,
  SecretBindings,
  SecretNeed,
  SecretSource,
  Secrets,
  SecretValues,
  ServiceNode,
} from '../node.ts';
export {
  dependency,
  freezeNode,
  isNode,
  isParamSource,
  isProvisionNeed,
  isSecretSource,
  module,
  paramNeed,
  paramSource,
  provisionNeed,
  ResourceNodeBase,
  resource,
  secret,
  secretSource,
  service,
} from '../node.ts';
