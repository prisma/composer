import * as path from 'node:path';
import type { ConfigAdapter, ConfigValues } from '@internal/core/config';
import { listFiles, parse } from 'dotenv-flow';

/** Reads the process environment when called: every variable whose value is a string. The default for both `config` and `secrets`. */
export function environmentVariables(): ConfigAdapter {
  return () => {
    const values: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (typeof value === 'string') values[name] = value;
    }
    return values;
  };
}

/** `dotenv-flow`'s own default pattern. Given it, `listFiles` also lists `.env.defaults`, first. */
const DOTENV_FLOW_PATTERN = '.env[.node_env][.local]';
const ENV_DEFAULTS_FILE = '.env.defaults';

function envFiles(configDirectory: string, environment: string): string[] {
  const files = listFiles({
    node_env: encodeURIComponent(environment),
    path: configDirectory,
    pattern: DOTENV_FLOW_PATTERN,
  });
  return files[0] === path.resolve(configDirectory, ENV_DEFAULTS_FILE) ? files.slice(1) : files;
}

function readEnvFile(file: string): ConfigValues {
  try {
    return parse(file);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`dotenv() could not read ${file}: ${message}`, { cause: error });
  }
}

/**
 * Reads `.env`, `.env.local`, `.env.<environment>` and `.env.<environment>.local` from the
 * directory of prisma.config.ts, in `dotenv-flow`'s order, a later file winning. It skips
 * `.env.local` for the environment `test`, as `dotenv-flow` does, and never reads
 * `.env.defaults`. It does not read or change the process environment.
 */
export function dotenv(): ConfigAdapter {
  return ({ environment, configDirectory }) => {
    const values: Record<string, string> = {};
    for (const file of envFiles(configDirectory, environment)) {
      Object.assign(values, readEnvFile(file));
    }
    return values;
  };
}
