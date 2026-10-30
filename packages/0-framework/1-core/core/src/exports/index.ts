/**
 * The authoring + control entry: node factories, Load, configOf, hydrate,
 * and the model types. Imports nothing — bundling a module that uses this
 * entry ships only this code. (/control carves out of here when the control
 * surface grows.) Pure barrel — no implementations live here.
 */

export type { Pointer } from '@internal/foundation/pointer';
export { isPlainPointer, isSecretPointer } from '@internal/foundation/pointer';
export type { SecretString } from '@internal/foundation/secret';
export { isSecretString, SecretBox } from '@internal/foundation/secret';
export type {
  Config,
  ConfigDeclaration,
  ConfigParam,
  Connection,
  Params,
  Values,
} from '../config.ts';
export {
  configOf,
  inputManifest,
  number,
  param,
  paramManifest,
  secretSourceManifest,
  string,
} from '../config.ts';
export type { Contract, ContractStyle } from '../contract.ts';
export type {
  AuthoredEdge,
  BoundaryPort,
  Edge,
  Graph,
  GraphNode,
  LoadOptions,
  NodeId,
  ParamBinding,
  PortEndpoint,
  SecretSourceUse,
  ServiceInputBinding,
} from '../graph.ts';
export { assertAppName, Load, LoadError, RESOURCE_OUT_PORT } from '../graph.ts';
export { hydrate, hydrateSync } from '../hydrate.ts';
export type { ModuleInput, ModuleInputField } from '../module-input.ts';
export type {
  BuildAdapter,
  DepBindings,
  DependencyEnd,
  Deps,
  Expose,
  Hydrated,
  HydratedDeps,
  InputBinding,
  InputBindingData,
  InputRef,
  InputValueOf,
  ModuleBuilder,
  ModuleContext,
  ModuleInputBinding,
  ModuleNode,
  ModuleOutputs,
  NODE,
  ParamBindings,
  ParamSource,
  ParamSourceOptions,
  ProvisionedRef,
  ProvisionNeed,
  RefPort,
  ResourceNode,
  ResourceProps,
  ResourcePropsMember,
  RunnableServiceNode,
  SecretSource,
  ServiceNode,
  SourceOptions,
} from '../node.ts';
export {
  dependency,
  freezeNode,
  isNode,
  isParamSource,
  isProvisionNeed,
  isSecretSource,
  module,
  paramSource,
  provisionNeed,
  ResourceNodeBase,
  resource,
  secretSource,
  service,
  slotsOf,
} from '../node.ts';
export type { EnvironmentFacts, PlainData, RealValuesOf, RuntimeValue, Value } from '../value.ts';
export { isValue, resolve } from '../value.ts';
