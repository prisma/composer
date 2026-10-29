import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ConfigAdapter, ConfigValues } from '@internal/core/config';
import { parse } from 'dotenv';

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
