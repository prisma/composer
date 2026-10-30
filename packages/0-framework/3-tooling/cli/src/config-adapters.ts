import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ConfigAdapter, ConfigValues } from '@internal/core/config';
import { parse } from 'dotenv';

/** The prefix of the variables Composer sets for itself, such as the ones it passes its own child processes. */
const COMPOSER_PREFIX = 'PRISMA_COMPOSER_';

/**
 * Set on a child Composer starts. It maps each variable without Composer's prefix
 * that Composer set or changed for the child to the parent's own value, or to null
 * where the parent had none, so the child's environmentVariables() returns what the
 * parent's did.
 */
const PARENT_VALUES_ENV = `${COMPOSER_PREFIX}PARENT_VALUES`;

/**
 * Reads the process environment when called: every variable whose value is a string,
 * except Composer's own `PRISMA_COMPOSER_` variables. The default for both `config` and `secrets`.
 */
export function environmentVariables(): ConfigAdapter {
  return () => {
    const values: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (typeof value === 'string' && !name.startsWith(COMPOSER_PREFIX)) values[name] = value;
    }
    for (const [name, parentValue] of parentValues()) {
      if (parentValue === null) delete values[name];
      else values[name] = parentValue;
    }
    return values;
  };
}

function parentValues(): [string, string | null][] {
  const text = process.env[PARENT_VALUES_ENV];
  if (text === undefined) return [];
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null) return [];
  return Object.entries(parsed).filter(
    (entry): entry is [string, string | null] => entry[1] === null || typeof entry[1] === 'string',
  );
}

/**
 * The variables Composer adds to a child's environment, plus the record of the parent's
 * own value for each one it sets or changes outside its prefix.
 */
export function childEnvironment(
  additions: Readonly<Record<string, string | undefined>>,
  parent: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string | undefined> {
  const changed: Record<string, string | null> = {};
  for (const [name, value] of Object.entries(additions)) {
    if (name.startsWith(COMPOSER_PREFIX) || value === undefined || parent[name] === value) continue;
    changed[name] = parent[name] ?? null;
  }
  return Object.keys(changed).length === 0
    ? { ...additions }
    : { ...additions, [PARENT_VALUES_ENV]: JSON.stringify(changed) };
}

function readEnvFile(file: string): ConfigValues {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) return {};
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`dotenv() could not read ${file}: ${message}`, { cause: error });
  }
  return parse(text);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/**
 * Reads `.env`, `.env.local`, `.env.<environment>` and `.env.<environment>.local` from the
 * directory of prisma.config.ts, a later file winning. A missing file is skipped. It does
 * not read the process environment.
 */
export function dotenv(): ConfigAdapter {
  return ({ environment, configDirectory }) => {
    const encoded = encodeURIComponent(environment);
    const values: Record<string, unknown> = {};
    for (const name of ['.env', '.env.local', `.env.${encoded}`, `.env.${encoded}.local`]) {
      Object.assign(values, readEnvFile(path.join(configDirectory, name)));
    }
    return values;
  };
}
