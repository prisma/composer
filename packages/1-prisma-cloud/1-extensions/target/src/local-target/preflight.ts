/**
 * Dev preflight (local-dev spec § 5, ADR-0041): the same name walk deploy's
 * preflight uses (`preflight-names.ts`), with dev's value-sourcing policy.
 * Every value comes from this run's environment: the shell, or a `.env` that
 * `prisma.config.ts` loads. An unset or empty secret is left out of the
 * service's input; it is an error only when the service's schema rejects
 * its absence. An unset or empty env-sourced param is always an error.
 *
 * Control-plane only, runs in the CLI parent (no CliError import — see
 * container.ts). Reads no Management API — dev is credential-free.
 */

import type { Graph, ServiceNode } from '@internal/core';
import { inputManifest } from '@internal/core';
import type { PreflightInput, PreflightPayload } from '@internal/core/config';
import { DEV_DIR } from '@internal/core/config';
import { removeRetiredSecretsFile } from '@internal/local-target';
import { serializeDevPreflightPayload } from '../dev-preflight-payload.ts';
import { collectPreflightNames, inputSecretNames, type PreflightName } from '../preflight-names.ts';
import { inputValidationFailure } from '../serializer.ts';

interface MissingSecrets {
  /** One name the schema requires, or several of which it requires some. */
  readonly names: readonly string[];
  readonly serviceAddress: string;
  readonly message: string;
}

type Env = Record<string, string | undefined>;

const isSet = (env: Env, name: string): boolean => {
  const value = env[name];
  return value !== undefined && value.length > 0;
};

const HOW_TO_SET =
  'Set each missing variable in either of these ways:\n' +
  '  - export it in the shell you run `prisma dev` from, or\n' +
  "  - load a .env file from prisma.config.ts, for example with process.loadEnvFile('.env') " +
  "or import 'dotenv/config'.";

function missingEnvParamsSection(missing: readonly PreflightName[]): string {
  const lines = missing.map((m) => `  - ${m.name}  (required by service "${m.serviceAddress}")`);
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
  const withoutAll = inputValidationFailure(node, serviceAddress, binding, env, new Set(unset));
  if (withoutAll === undefined) return [];
  const required: MissingSecrets[] = [];
  for (const name of unset) {
    const message = inputValidationFailure(node, serviceAddress, binding, env, new Set([name]));
    if (message !== undefined) required.push({ names: [name], serviceAddress, message });
  }
  return required.length > 0 ? required : [{ names: unset, serviceAddress, message: withoutAll }];
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function runDevPreflight(input: PreflightInput): Promise<PreflightPayload> {
  // No `node:path` import (invariant 5) — local dev is POSIX-only (spec's
  // Windows note), so a plain `/`-join is exact, not an approximation.
  await removeRetiredSecretsFile(`${process.cwd()}/${DEV_DIR}`);
  const env = process.env;

  const absentSecrets = new Set<string>();
  const pointed = new Set<string>();
  const missingSecrets: MissingSecrets[] = [];
  const invalidInputs: string[] = [];
  for (const { serviceAddress, binding } of inputManifest(input.graph)) {
    const names = inputSecretNames(binding, serviceAddress);
    const unset = names.filter((name) => !isSet(env, name));
    for (const name of names) (isSet(env, name) ? pointed : absentSecrets).add(name);
    if (unset.length === 0) continue;
    const node = serviceNodeAt(input.graph, serviceAddress);
    const invalid = inputValidationFailure(node, serviceAddress, binding, env, new Set());
    if (invalid !== undefined) {
      invalidInputs.push(`invalid input for service "${serviceAddress}": ${invalid}`);
      continue;
    }
    missingSecrets.push(...requiredSecrets(node, serviceAddress, binding, unset, env));
  }

  const missingParams: PreflightName[] = [];
  for (const param of collectPreflightNames(input.graph).envParams) {
    if (isSet(env, param.name)) pointed.add(param.name);
    else missingParams.push(param);
  }

  const missing = [
    ...(missingParams.length > 0 ? [missingEnvParamsSection(missingParams)] : []),
    ...(missingSecrets.length > 0 ? [missingSecretsSection(missingSecrets)] : []),
  ];
  const sections = [...invalidInputs, ...missing, ...(missing.length > 0 ? [HOW_TO_SET] : [])];
  if (sections.length > 0) {
    throw new Error(`local dev preflight failed:\n\n${sections.join('\n\n')}`);
  }

  if (absentSecrets.size === 0 && pointed.size === 0) return undefined;
  const fingerprints: Record<string, string> = {};
  for (const name of pointed) fingerprints[name] = await sha256Hex(env[name] ?? '');
  return serializeDevPreflightPayload({ absentSecrets: [...absentSecrets], fingerprints });
}
