import * as fs from 'node:fs';
import type { CheckedConfiguration, CheckedRootField } from '@internal/core';
import type { AppSecrets } from '@internal/core/config';

/** Names the configuration file the first process wrote for this run (ADR-0062). */
export const CONFIGURATION_FILE_ENV = 'PRISMA_COMPOSER_CONFIGURATION_FILE';
/** Lists, as JSON, the node addresses the first process checked. */
export const NODE_ADDRESSES_ENV = 'PRISMA_COMPOSER_NODE_ADDRESSES';
/** `prisma dev` only: the value of each app secret an `envSecret()` in the graph names, as a JSON object. */
export const APP_SECRETS_ENV = 'PRISMA_COMPOSER_APP_SECRETS';

/** Writes `checked` to `file` as JSON, readable only by its owner. A file already there is replaced. */
export function writeConfigurationFile(file: string, checked: CheckedConfiguration): void {
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, JSON.stringify(checked), { mode: 0o600, flag: 'wx' });
}

/** Deletes `file`. Never throws: the run's own result is the one to report. */
export function removeConfigurationFile(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // The run already ended; a file left behind is a smaller problem than a masked result.
  }
}

/** What the first process adds to the second process's environment. `secrets` is given by `prisma dev` only. */
export function secondProcessEnvironment(input: {
  readonly configurationFile: string;
  readonly nodeAddresses: readonly string[];
  readonly secrets?: AppSecrets;
}): Record<string, string> {
  return {
    [CONFIGURATION_FILE_ENV]: input.configurationFile,
    [NODE_ADDRESSES_ENV]: JSON.stringify(input.nodeAddresses),
    ...(input.secrets === undefined ? {} : { [APP_SECRETS_ENV]: JSON.stringify(input.secrets) }),
  };
}

function missingVariable(name: string, what: string): string {
  return `${name} is not set. This stack file runs as the second process of a Composer deploy, destroy or prisma dev, which ${what}.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTextList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((member) => typeof member === 'string');
}

function rootFieldsOf(value: unknown): CheckedRootField[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const fields: CheckedRootField[] = [];
  for (const member of value) {
    if (!isRecord(member) || !isTextList(member['path'])) return undefined;
    fields.push(
      'value' in member
        ? { path: member['path'], value: member['value'] }
        : { path: member['path'] },
    );
  }
  return fields;
}

function textValuesOf(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const values: Record<string, string> = {};
  for (const [key, member] of Object.entries(value)) {
    if (typeof member !== 'string') return undefined;
    values[key] = member;
  }
  return values;
}

/** Second process: what the first process checked, from the configuration file and the node addresses it names. */
export function readCheckedConfiguration(env: Readonly<Record<string, string | undefined>>): {
  readonly configuration: CheckedConfiguration;
  readonly nodeAddresses: readonly string[];
} {
  const file = env[CONFIGURATION_FILE_ENV];
  if (file === undefined || file === '') {
    throw new Error(
      missingVariable(CONFIGURATION_FILE_ENV, 'names the configuration file it wrote there'),
    );
  }
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `Could not read the configuration file ${file}: ${message}. Composer deletes it when the run ends, so a stack file run by hand after that cannot read it; run the command again.`,
      { cause },
    );
  }
  const notComposers = (what: string) =>
    new Error(`The configuration file ${file} is not one Composer wrote: ${what}.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw notComposers('it is not JSON');
  }
  if (!isRecord(parsed)) throw notComposers('it is not JSON');
  const rootInput = rootFieldsOf(parsed['rootInput']);
  if (rootInput === undefined) throw notComposers('rootInput is not a list of fields');
  const values = textValuesOf(parsed['values']);
  if (values === undefined) throw notComposers('values is not an object of text');

  const addresses = env[NODE_ADDRESSES_ENV];
  if (addresses === undefined || addresses === '') {
    throw new Error(
      missingVariable(NODE_ADDRESSES_ENV, 'lists the node addresses it checked there'),
    );
  }
  let nodeAddresses: unknown;
  try {
    nodeAddresses = JSON.parse(addresses);
  } catch {
    nodeAddresses = undefined;
  }
  if (!isTextList(nodeAddresses)) {
    throw new Error(`${NODE_ADDRESSES_ENV} is not a JSON list of node addresses.`);
  }
  return { configuration: { rootInput, values }, nodeAddresses };
}

/** Second process, under `prisma dev`: the app secrets the first process handed it. */
export function appSecretsFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): AppSecrets {
  const text = env[APP_SECRETS_ENV];
  if (text === undefined || text === '') {
    throw new Error(
      missingVariable(APP_SECRETS_ENV, 'hands the app secrets the local services need there'),
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const values = textValuesOf(parsed);
  if (values === undefined) throw new Error(`${APP_SECRETS_ENV} is not a JSON object of text.`);
  const secrets: Record<string, string> = Object.create(null);
  Object.assign(secrets, values);
  return Object.freeze(secrets);
}
