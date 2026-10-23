/**
 * The resource IDs and env keys the release before ADR-0057 built, when an
 * address left out the app name. Every resource declares its old ID with
 * `renamedFrom`, so a stage deployed by that release keeps its resources.
 * Delete this file once no such stage remains.
 */
import { renamedFrom } from 'alchemy/Rename';
import { addressBelowApp } from './resource-ids.ts';
import { configKey, generatedParamVarName, inputKey } from './serializer.ts';

/** `<address below the app>-<suffix>`: the App, Deployment, Database, Connection, warm-up, migration, Bucket, access key and S3 credentials. */
export function legacyNodeResourceId(app: string, address: string, suffix: string): string {
  return `${addressBelowApp(address, app)}-${suffix}`;
}

/** An environment variable row: its old key, then `-var`. */
export function legacyEnvVarId(legacyKey: string): string {
  return `${legacyKey}-var`;
}

/** The key a config row had when its address left out the app name. */
export function legacyConfigKey(
  app: string,
  address: string,
  d: Parameters<typeof configKey>[1],
): string {
  return configKey(addressBelowApp(address, app), d);
}

/** The input document row's old key. */
export function legacyInputKey(app: string, address: string): string {
  return inputKey(addressBelowApp(address, app));
}

/** A generated input leaf's old variable name. */
export function legacyGeneratedParamVarName(app: string, address: string, path: string): string {
  return generatedParamVarName(addressBelowApp(address, app), path);
}

/** A generated input leaf's value: `<old input key>:<path>-generated`. */
export function legacyGeneratedParamId(app: string, address: string, path: string): string {
  return `${legacyInputKey(app, address)}:${path}-generated`;
}

/** An RPC service key, minted per calling service and input. */
export function legacyServiceKeyId(app: string, consumerAddress: string, input: string): string {
  return `servicekey-${addressBelowApp(consumerAddress, app)}.${input}`;
}

/** A streams provider's key, minted per providing service. */
export function legacyStreamsKeyId(app: string, providerAddress: string): string {
  return `streamskey-${addressBelowApp(providerAddress, app)}`;
}

/** Declares the resource's legacy ID, so Alchemy moves its state instead of recreating it. */
export const fromLegacyId = (legacyId: string) => renamedFrom(legacyId);
