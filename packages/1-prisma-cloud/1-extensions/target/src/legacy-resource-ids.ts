/**
 * The resource IDs and env keys the release before ADR-0056 built, when an
 * address left out the app name. Every resource declares its old ID with
 * `renamedFrom`, so a stage deployed by that release keeps its resources.
 * Delete this file once no such stage remains.
 */
import { renamedFrom } from 'alchemy/Rename';
import { configKey, generatedParamVarName, inputKey } from './serializer.ts';

/** The address the previous release used: the full address without its first segment, the app name. */
export function legacyAddress(address: string): string {
  const dot = address.indexOf('.');
  return dot === -1 ? '' : address.slice(dot + 1);
}

/** `<legacy address>-<suffix>`: the App, Deployment, Database, Connection, warm-up, migration, Bucket, access key and S3 credentials. */
export function legacyNodeResourceId(address: string, suffix: string): string {
  return `${legacyAddress(address)}-${suffix}`;
}

/** An environment variable row: its key, built from the legacy address, then `-var`. */
export function legacyEnvVarId(legacyKey: string): string {
  return `${legacyKey}-var`;
}

/** The key a config row had under the legacy address. */
export function legacyConfigKey(address: string, d: Parameters<typeof configKey>[1]): string {
  return configKey(legacyAddress(address), d);
}

/** The input document row's key under the legacy address. */
export function legacyInputKey(address: string): string {
  return inputKey(legacyAddress(address));
}

/** A generated input leaf's variable under the legacy address. */
export function legacyGeneratedParamVarName(address: string, path: string): string {
  return generatedParamVarName(legacyAddress(address), path);
}

/** A generated input leaf's value: `<legacy input key>:<path>-generated`. */
export function legacyGeneratedParamId(address: string, path: string): string {
  return `${legacyInputKey(address)}:${path}-generated`;
}

/** An RPC service key, minted per calling service and input. */
export function legacyServiceKeyId(consumerAddress: string, input: string): string {
  return `servicekey-${legacyAddress(consumerAddress)}.${input}`;
}

/** A streams provider's key, minted per provider. */
export function legacyStreamsKeyId(providerAddress: string): string {
  return `streamskey-${legacyAddress(providerAddress)}`;
}

/** Declares the resource's legacy ID, so Alchemy moves its state instead of recreating it. */
export const fromLegacyId = (legacyId: string) => renamedFrom(legacyId);
