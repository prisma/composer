/**
 * Control-plane only, runs in the CLI parent (no CliError import — see
 * container.ts). Reads no Management API — dev is credential-free.
 */

import type { Graph, ServiceNode } from '@internal/core';
import { inputManifest } from '@internal/core';
import type {
  DevPreflightResult,
  PlatformVariableReader,
  PreflightInput,
} from '@internal/core/config';
import { DEV_DIR, devEnvironmentDir } from '@internal/core/config';
import { quotedList } from '@internal/foundation/errors';
import {
  movePreEnvironmentDevState,
  readOrCreateFingerprintKey,
  removeRetiredSecretsFile,
} from '@internal/local-target';
import { configurationText } from '../configuration-text.ts';
import { serializeDevPreflightPayload } from '../control/preflight-payload.ts';
import { addReader, missingVariablesText } from '../missing-variables-text.ts';
import { platformVariableNodes } from '../platform-variable.ts';
import {
  envParamBindings,
  envParamNotTextError,
  inputVariableNames,
  perKeyVariableBindings,
  type VariableName,
} from '../preflight-names.ts';
import { checkPublicUrls, publicUrlStrategies } from '../public-url.ts';
import {
  checkRequirements,
  type MissingVariables,
  paramIsRequired,
  requiredParam,
} from '../required-variables.ts';

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

function serviceNodeAt(graph: Graph, address: string): ServiceNode {
  const found = graph.nodes.find((entry) => entry.id === address)?.node;
  if (found?.kind !== 'service') {
    throw new Error(`local dev preflight: no service node at address "${address}".`);
  }
  return found;
}

function plainVariableNotTextError(
  name: string,
  address: string,
  readers: readonly string[],
  kind: string,
): Error {
  const readBy =
    readers.length === 1
      ? `which service ${quotedList(readers)} reads`
      : `which services ${quotedList(readers)} read`;
  return new Error(
    `The \`config\` adapters return ${kind} for "${name}", not text. prisma dev cannot start, because the platform variable "${address}", ${readBy}, takes text. Make the adapter return a string.`,
  );
}

function plainVariableTexts(input: PreflightInput): Record<string, string> {
  const texts: Record<string, string> = {};
  for (const node of platformVariableNodes(input.graph)) {
    if (node.secret) continue;
    const readers = [
      ...new Set(
        input.graph.valueReads
          .filter((read) => read.resource === node.address)
          .map((read) => read.reader),
      ),
    ];
    if (readers.length === 0) continue;
    const text = configurationText(input.configuration, node.name, (kind) =>
      plainVariableNotTextError(node.name, node.address, readers, kind),
    );
    if (isSet(text)) texts[node.name] = text;
  }
  return texts;
}

/** HMAC-SHA256 under a local random key, so the fingerprints in Alchemy state cannot be checked against guessed values without the key file. */
async function fingerprint(key: CryptoKey, value: string): Promise<string> {
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function runDevPreflight(input: PreflightInput): Promise<DevPreflightResult> {
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
  const env = input.configuration;
  const plainVariableText = plainVariableTexts(input);
  const variableValue = (variable: VariableName): string | undefined =>
    variable.secret ? input.secrets[variable.name] : plainVariableText[variable.name];
  const secretValue = (name: string): string | undefined => input.secrets[name];

  const absentSecrets = new Set<string>();
  const secretNames = new Set<string>();
  const pointed = new Map<string, string>();
  const required: MissingVariables[] = [];
  const readers = new Map<string, PlatformVariableReader[]>();
  const invalidInputs: string[] = [];
  for (const { serviceAddress, binding } of inputManifest(input.graph)) {
    const variables = inputVariableNames(binding, serviceAddress);
    const unset: string[] = [];
    for (const variable of variables) {
      if (variable.secret) secretNames.add(variable.name);
      const value = variableValue(variable);
      if (isSet(value)) {
        pointed.set(variable.name, value);
      } else {
        unset.push(variable.name);
        absentSecrets.add(variable.name);
      }
    }
    if (unset.length === 0) continue;
    const node = serviceNodeAt(input.graph, serviceAddress);
    const decided = checkRequirements(node, serviceAddress, binding, unset, env);
    if (decided.kind === 'invalid') {
      invalidInputs.push(`invalid input for service "${serviceAddress}": ${decided.message}`);
      continue;
    }
    for (const marker of decided.markers) {
      if (unset.includes(marker.name)) {
        addReader(readers, marker.name, {
          kind: 'field',
          service: serviceAddress,
          path: marker.path,
        });
      }
    }
    required.push(...decided.missing);
  }

  for (const param of perKeyVariableBindings(input.graph)) {
    const value = plainVariableText[param.name];
    if (isSet(value)) {
      pointed.set(param.name, value);
      continue;
    }
    if (!paramIsRequired(serviceNodeAt(input.graph, param.serviceAddress), param.param)) continue;
    addReader(readers, param.name, {
      kind: 'param',
      service: param.serviceAddress,
      param: param.param,
    });
    required.push(requiredParam(param));
  }

  for (const param of envParamBindings(input.graph)) {
    const value = secretNames.has(param.name)
      ? secretValue(param.name)
      : configurationText(env, param.name, (kind) =>
          envParamNotTextError(param.name, param.serviceAddress, kind),
        );
    if (isSet(value)) {
      pointed.set(param.name, value);
      continue;
    }
    if (!paramIsRequired(serviceNodeAt(input.graph, param.serviceAddress), param.param)) continue;
    addReader(readers, param.name, {
      kind: 'param',
      service: param.serviceAddress,
      param: param.param,
    });
    required.push(requiredParam(param));
  }

  const missing = required.length > 0 ? [missingVariablesText(required, readers)] : [];
  const sections = [
    ...invalidInputs,
    ...missing,
    ...(missing.length > 0 ? [howToSet(input.environment)] : []),
  ];
  if (sections.length > 0) {
    throw new Error(`prisma dev cannot start:\n\n${sections.join('\n\n')}`);
  }

  if (absentSecrets.size === 0 && pointed.size === 0) {
    return { payload: undefined, plainVariableText };
  }
  const key = await crypto.subtle.importKey(
    'raw',
    await readOrCreateFingerprintKey(devDir),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const pointerVersions: Record<string, string> = {};
  for (const [name, value] of pointed) pointerVersions[name] = await fingerprint(key, value);
  return {
    payload: serializeDevPreflightPayload({ absentSecrets: [...absentSecrets], pointerVersions }),
    plainVariableText,
  };
}
