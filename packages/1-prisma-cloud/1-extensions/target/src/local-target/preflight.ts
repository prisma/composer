/**
 * Dev preflight (local-dev spec § 5, ADR-0041): the same name walk deploy's
 * preflight uses (`preflight-names.ts`), with dev's value-sourcing policy.
 * Every value comes from the pools the command read: secrets from the secrets pool, env-sourced params from the config pool. An unset or empty secret is left out of the
 * service's input; it is an error only when the service's schema rejects
 * its absence. An unset or empty env-sourced param is always an error.
 *
 * Control-plane only, runs in the CLI parent (no CliError import — see
 * container.ts). Reads no Management API — dev is credential-free.
 */

import type { Graph, ServiceNode } from '@internal/core';
import { inputManifest } from '@internal/core';
import type { PreflightInput, PreflightPayload } from '@internal/core/config';
import { DEV_DIR, devEnvironmentDir } from '@internal/core/config';
import {
  movePreEnvironmentDevState,
  readOrCreateFingerprintKey,
  removeRetiredSecretsFile,
} from '@internal/local-target';
import { serializeDevPreflightPayload } from '../control/preflight-payload.ts';
import { poolText } from '../pool-text.ts';
import {
  collectPreflightNames,
  envParamNotTextError,
  inputSecretNames,
  type PreflightName,
} from '../preflight-names.ts';
import { checkPublicUrls, publicUrlStrategies } from '../public-url.ts';
import { inputValidationFailure } from '../serializer.ts';

interface MissingSecrets {
  /** One name the schema requires, or several of which it requires some. */
  readonly names: readonly string[];
  readonly serviceAddress: string;
  readonly message: string;
}

type Env = Readonly<Record<string, unknown>>;

const isSet = (value: string | undefined): value is string =>
  value !== undefined && value.length > 0;

function howToSet(environment: string): string {
  const encoded = encodeURIComponent(environment);
  return (
    'Set each missing variable where an adapter in prisma.config.ts reads it: the `secrets` list of ' +
    'the `composer` section for a secret, the `config` list for an env-sourced param. ' +
    'environmentVariables() reads the shell you run `prisma dev` from; dotenv() reads .env, ' +
    `.env.local, .env.${encoded} and .env.${encoded}.local beside prisma.config.ts.`
  );
}

function missingEnvParamsSection(missing: readonly PreflightName[]): string {
  const lines = missing.map((m) => `  - ${m.name}  (required by service "${m.address}")`);
  return `${missing.length} env-sourced param(s) are not set:\n${lines.join('\n')}`;
}

function missingSecretsSection(missing: readonly MissingSecrets[]): string {
  const lines = missing.map((m) =>
    m.names.length === 1
      ? `  - ${m.names[0]}  (required by service "${m.serviceAddress}": ${m.message})`
      : `  - some of ${m.names.join(', ')}  (service "${m.serviceAddress}" needs some of them: ` +
        `${m.message})`,
  );
  return `required secrets are not set:\n${lines.join('\n')}`;
}

function serviceNodeAt(graph: Graph, address: string): ServiceNode {
  const found = graph.nodes.find((entry) => entry.id === address)?.node;
  if (found?.kind !== 'service') {
    throw new Error(`local dev preflight: no service node at address "${address}".`);
  }
  return found;
}

/** The secrets this service's schema cannot do without, among the ones that are unset. */
function requiredSecrets(
  node: ServiceNode,
  serviceAddress: string,
  binding: unknown,
  unset: readonly string[],
  env: Env,
): MissingSecrets[] {
  const withoutAll = inputValidationFailure(node, serviceAddress, binding, {
    env,
    absentSecrets: new Set(unset),
  });
  if (withoutAll === undefined) return [];
  const required: MissingSecrets[] = [];
  for (const name of unset) {
    const message = inputValidationFailure(node, serviceAddress, binding, {
      env,
      absentSecrets: new Set([name]),
    });
    if (message !== undefined) required.push({ names: [name], serviceAddress, message });
  }
  return required.length > 0 ? required : [{ names: unset, serviceAddress, message: withoutAll }];
}

/** HMAC-SHA256 under a local random key, so the fingerprints in Alchemy state cannot be checked against guessed values without the key file. */
async function fingerprint(key: CryptoKey, value: string): Promise<string> {
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function runDevPreflight(input: PreflightInput): Promise<PreflightPayload> {
  checkPublicUrls(input.graph);
  for (const { address, strategy } of publicUrlStrategies(input.graph)) {
    if (strategy.strategy === 'hostname') {
      input.warn?.(
        `${address} names the hostname ${strategy.hostname}. prisma dev ignores it and serves the service on its local URL.`,
      );
    }
  }
  // No `node:path` import (invariant 5) — local dev is POSIX-only (spec's
  // Windows note), so a plain `/`-join is exact, not an approximation.
  movePreEnvironmentDevState(process.cwd());
  const devDir = `${process.cwd()}/${devEnvironmentDir(input.environment)}`;
  await removeRetiredSecretsFile(`${process.cwd()}/${DEV_DIR}`);
  await removeRetiredSecretsFile(devDir);
  const env = input.pools.config;
  const secretValue = (name: string): string | undefined => input.pools.secrets[name];

  const absentSecrets = new Set<string>();
  const secretNames = new Set<string>();
  const pointed = new Map<string, string>();
  const missingSecrets: MissingSecrets[] = [];
  const invalidInputs: string[] = [];
  for (const { serviceAddress, binding } of inputManifest(input.graph)) {
    const names = inputSecretNames(binding, serviceAddress);
    const unset = names.filter((name) => !isSet(secretValue(name)));
    for (const name of names) {
      secretNames.add(name);
      const value = secretValue(name);
      if (isSet(value)) pointed.set(name, value);
      else absentSecrets.add(name);
    }
    if (unset.length === 0) continue;
    const node = serviceNodeAt(input.graph, serviceAddress);
    const invalid = inputValidationFailure(node, serviceAddress, binding, {
      env,
      absentSecrets: new Set(),
    });
    if (invalid !== undefined) {
      invalidInputs.push(`invalid input for service "${serviceAddress}": ${invalid}`);
      continue;
    }
    missingSecrets.push(...requiredSecrets(node, serviceAddress, binding, unset, env));
  }

  const missingParams: PreflightName[] = [];
  for (const param of collectPreflightNames(input.graph).envParams) {
    const value = secretNames.has(param.name)
      ? secretValue(param.name)
      : poolText(env, param.name, (kind) => envParamNotTextError(param.name, param.address, kind));
    if (isSet(value)) pointed.set(param.name, value);
    else missingParams.push(param);
  }

  const missing = [
    ...(missingParams.length > 0 ? [missingEnvParamsSection(missingParams)] : []),
    ...(missingSecrets.length > 0 ? [missingSecretsSection(missingSecrets)] : []),
  ];
  const sections = [
    ...invalidInputs,
    ...missing,
    ...(missing.length > 0 ? [howToSet(input.environment)] : []),
  ];
  if (sections.length > 0) {
    throw new Error(`prisma dev cannot start:\n\n${sections.join('\n\n')}`);
  }

  if (absentSecrets.size === 0 && pointed.size === 0) return undefined;
  const key = await crypto.subtle.importKey(
    'raw',
    await readOrCreateFingerprintKey(devDir),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const pointerVersions: Record<string, string> = {};
  for (const [name, value] of pointed) pointerVersions[name] = await fingerprint(key, value);
  return serializeDevPreflightPayload({ absentSecrets: [...absentSecrets], pointerVersions });
}
