import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AppConfigurationRead, RootInputField } from '@internal/core';
import { type AppSecrets, DEV_DIR, type NamedSecrets } from '@internal/core/config';
import { CliStructuredError } from '@internal/foundation/errors';

/** Names the app configuration file the first process wrote for this run (ADR-0062). */
export const APP_CONFIGURATION_FILE_ENV = 'PRISMA_COMPOSER_APP_CONFIGURATION_FILE';
/** `prisma dev` only: the named secrets, as a JSON object. */
export const NAMED_SECRETS_ENV = 'PRISMA_COMPOSER_NAMED_SECRETS';

/** What the app configuration file holds: what the first process's Load read from the app configuration, and the node addresses of the graph it built. */
export interface AppConfigurationFile {
  readonly appConfigurationRead: AppConfigurationRead;
  readonly nodeAddresses: readonly string[];
}

const FILE_NAME = /^app-configuration-(\d+)(-[^/]*)?\.json$/;

/** The app configuration file a deploy or destroy run writes: unique per run, so concurrent runs from one checkout never share one. */
export function deployAppConfigurationFile(cwd: string, runId: string): string {
  return path.join(
    cwd,
    '.prisma-composer',
    `app-configuration-${String(process.pid)}-${runId}.json`,
  );
}

/** The app configuration file `prisma dev` writes in an environment's folder. */
export function devAppConfigurationFile(devDir: string): string {
  return path.join(devDir, `app-configuration-${String(process.pid)}.json`);
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

/**
 * Deletes the app configuration files that earlier runs left in `.prisma-composer/` and in
 * each dev environment's folder: a run stopped by a forced exit skips its own cleanup. A file
 * whose process is still running is kept. Never throws.
 */
export function removeLeftoverAppConfigurationFiles(cwd: string): void {
  const devRoot = path.join(cwd, DEV_DIR);
  const dirs = [path.join(cwd, '.prisma-composer')];
  try {
    for (const entry of fs.readdirSync(devRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(path.join(devRoot, entry.name));
    }
  } catch {
    // No dev environment yet.
  }
  for (const dir of dirs) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const pid = Number(FILE_NAME.exec(name)?.[1]);
      if (Number.isNaN(pid) || pid === process.pid || isRunning(pid)) continue;
      try {
        fs.rmSync(path.join(dir, name), { force: true });
      } catch {
        // A file left behind is a smaller problem than a run that cannot start.
      }
    }
  }
}

function textIn(value: unknown, at: readonly string[]): { at: readonly string[]; text: string }[] {
  if (typeof value === 'string') return [{ at, text: value }];
  if (Array.isArray(value)) {
    return value.flatMap((member, index) => textIn(member, [...at, String(index)]));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, member]) => textIn(member, [...at, key]));
  }
  return [];
}

/** Refuses when the file would hold the text of a secret. The message names where, never the text. */
function refuseSecretsIn(read: AppConfigurationRead, secrets: ReadonlySet<string>): void {
  const places = [
    ...read.rootInput.flatMap((field) =>
      textIn(field.value, field.path).map(({ at, text }) => ({
        where: `Root input field input.${at.join('.')}`,
        text,
      })),
    ),
    ...Object.entries(read.configurationKeyText).map(([key, text]) => ({
      where: `Configuration key "${key}"`,
      text,
    })),
  ];
  const place = places.find(({ text }) => secrets.has(text));
  if (place === undefined) return;
  throw new CliStructuredError(
    'CONFIG.SECRET_AS_PLAIN_VALUE',
    `${place.where} holds the text of a secret. Composer hands the second process every plain value Load read, in a file, and never writes a secret to a file.`,
    {
      fix: 'Read the secret with envSecret() where it is used, or give this plain value text that is not a secret.',
    },
  );
}

/** What the first process hands the second: the app configuration file, and the environment that names it. */
export interface SecondProcessHandover {
  /** What the first process adds to the second process's environment. */
  readonly env: Readonly<Record<string, string>>;
  /** Writes the app configuration file, readable only by its owner. A file already there is replaced. */
  writeFile(): void;
  /** Deletes the app configuration file. Never throws: the run's own result is the one to report. */
  removeFile(): void;
}

/**
 * First process: the handover to the second process (ADR-0062). The app configuration file at
 * `file` holds what Load read and the graph's node addresses. With `appSecrets`, which only
 * `prisma dev` passes, the environment also carries the named secrets: the app secrets under
 * the graph's secrets keys, each with text. Refuses when the file would hold any of
 * `secretValues`. Every input is plain data from the graph, such as `graph.appConfigurationRead`,
 * `nodeAddresses(graph)` and `secretsKeys(graph)`, so a caller with its own copy of Composer's
 * core can pass them.
 */
export function prepareSecondProcess(input: {
  readonly file: string;
  readonly appConfigurationRead: AppConfigurationRead;
  readonly nodeAddresses: readonly string[];
  readonly secretsKeys: readonly string[];
  readonly secretValues: ReadonlySet<string>;
  readonly appSecrets?: AppSecrets;
}): SecondProcessHandover {
  const { file, appSecrets } = input;
  refuseSecretsIn(input.appConfigurationRead, input.secretValues);
  const contents: AppConfigurationFile = {
    appConfigurationRead: input.appConfigurationRead,
    nodeAddresses: input.nodeAddresses,
  };
  const env: Record<string, string> = { [APP_CONFIGURATION_FILE_ENV]: file };
  if (appSecrets !== undefined) {
    const named: Record<string, string> = {};
    for (const key of input.secretsKeys) {
      const text = appSecrets[key];
      if (text !== undefined && text !== '') named[key] = text;
    }
    env[NAMED_SECRETS_ENV] = JSON.stringify(named);
  }
  return {
    env,
    writeFile() {
      fs.rmSync(file, { force: true });
      fs.writeFileSync(file, JSON.stringify(contents), { mode: 0o600, flag: 'wx' });
    },
    removeFile() {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // The run already ended; a file left behind is a smaller problem than a masked result.
      }
    },
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

function rootFieldsOf(value: unknown): RootInputField[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const fields: RootInputField[] = [];
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

function textByKeyOf(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const byKey: Record<string, string> = {};
  for (const [key, member] of Object.entries(value)) {
    if (typeof member !== 'string') return undefined;
    byKey[key] = member;
  }
  return byKey;
}

/** Second process: the app configuration file the first process named in its environment. */
export function readAppConfigurationFile(
  env: Readonly<Record<string, string | undefined>>,
): AppConfigurationFile {
  const file = env[APP_CONFIGURATION_FILE_ENV];
  if (file === undefined || file === '') {
    throw new Error(
      missingVariable(
        APP_CONFIGURATION_FILE_ENV,
        'names the app configuration file it wrote there',
      ),
    );
  }
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `Could not read the app configuration file ${file}: ${message}. Composer deletes it when the run ends, so a stack file run by hand after that cannot read it; run the command again.`,
      { cause },
    );
  }
  const notComposers = (what: string) =>
    new Error(`The app configuration file ${file} is not one Composer wrote: ${what}.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw notComposers('it is not JSON');
  }
  if (!isRecord(parsed)) throw notComposers('it is not JSON');
  const read = parsed['appConfigurationRead'];
  if (!isRecord(read)) throw notComposers('appConfigurationRead is not an object');
  const rootInput = rootFieldsOf(read['rootInput']);
  if (rootInput === undefined) throw notComposers('rootInput is not a list of fields');
  const configurationKeyText = textByKeyOf(read['configurationKeyText']);
  if (configurationKeyText === undefined) {
    throw notComposers('configurationKeyText is not an object of text');
  }
  const addresses = parsed['nodeAddresses'];
  if (!isTextList(addresses)) throw notComposers('nodeAddresses is not a list of node addresses');
  return { appConfigurationRead: { rootInput, configurationKeyText }, nodeAddresses: addresses };
}

/** Second process, under `prisma dev`: the named secrets the first process handed it. */
export function namedSecretsFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): NamedSecrets {
  const text = env[NAMED_SECRETS_ENV];
  if (text === undefined || text === '') {
    throw new Error(
      missingVariable(NAMED_SECRETS_ENV, 'hands the secrets the local services need there'),
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const byKey = textByKeyOf(parsed);
  if (byKey === undefined) throw new Error(`${NAMED_SECRETS_ENV} is not a JSON object of text.`);
  const secrets: Record<string, string> = Object.create(null);
  Object.assign(secrets, byKey);
  return Object.freeze(secrets);
}
