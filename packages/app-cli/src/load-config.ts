/**
 * Pipeline step: find and load `prisma-app.config.ts` (ADR-0017) — the ONE
 * file that imports control-plane code. Discovery is the standard walk-up
 * from the deploy entry's directory (mirrors prisma-next's config-loader);
 * loading is c12 with that explicit path (rc/global/package.json lookups
 * disabled), so the config file's own static imports resolve from the app
 * root by whatever package manager runs — no specifier construction, no
 * anchoring. The loaded shape is validated field-by-field with CliErrors
 * naming the field.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ExtensionDescriptor, PrismaAppConfig } from '@prisma/app/config';
import { loadConfig as c12LoadConfig } from 'c12';
import { CliError } from './cli-error.ts';

export const CONFIG_FILENAME = 'prisma-app.config.ts';

export interface LoadedAppConfig {
  /** The discovered config file's absolute path — the generated stack file imports it by a path relative to itself. */
  readonly path: string;
  readonly config: PrismaAppConfig;
}

/** Walks UP from the entry file's directory looking for the literal CONFIG_FILENAME; undefined when the walk hits the filesystem root. */
export function findConfigPathForEntry(entryPath: string): string | undefined {
  let current = path.dirname(path.resolve(entryPath));
  while (true) {
    const candidate = path.join(current, CONFIG_FILENAME);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function missingConfigError(entryPath: string): CliError {
  return new CliError(
    `No ${CONFIG_FILENAME} found walking up from "${path.dirname(path.resolve(entryPath))}" — ` +
      "the deploy needs the app's config file. Create one next to (or above) the entry, " +
      "default-exporting defineConfig({ extensions: [...], state: ... }) from '@prisma/app/config'.",
  );
}

function requireField(condition: boolean, field: string, requirement: string): void {
  if (!condition) {
    throw new CliError(
      `${CONFIG_FILENAME}: \`${field}\` ${requirement} — see defineConfig() in '@prisma/app/config'.`,
    );
  }
}

/**
 * Field-by-field validation of the loaded default export — deliberately no
 * schema library: each check is a CliError naming the offending field.
 * Returns the same object, typed.
 */
export function validateConfigShape(loaded: unknown, configPath: string): PrismaAppConfig {
  if (typeof loaded !== 'object' || loaded === null || Object.keys(loaded).length === 0) {
    throw new CliError(
      `"${configPath}" exported no config — it must default-export ` +
        "defineConfig({ extensions: [...], state: ... }) from '@prisma/app/config'.",
    );
  }
  const candidate = loaded as { extensions?: unknown; state?: unknown };

  requireField(Array.isArray(candidate.extensions), 'extensions', 'must be an array');
  const extensions = candidate.extensions as unknown[];
  const seen = new Set<string>();
  for (const [index, entry] of extensions.entries()) {
    requireField(
      typeof entry === 'object' && entry !== null,
      `extensions[${index}]`,
      'must be an extension descriptor object',
    );
    const descriptor = entry as { id?: unknown; nodes?: unknown };
    requireField(
      typeof descriptor.id === 'string' && descriptor.id.length > 0,
      `extensions[${index}].id`,
      'must be a non-empty string (the extension package name)',
    );
    requireField(
      typeof descriptor.nodes === 'object' && descriptor.nodes !== null,
      `extensions[${index}].nodes`,
      'must be an object (the node-ID → control registry)',
    );
    const id = descriptor.id as string;
    if (seen.has(id)) {
      throw new CliError(
        `${CONFIG_FILENAME}: extension "${id}" is listed more than once in \`extensions\`.`,
      );
    }
    seen.add(id);
  }

  requireField(
    typeof candidate.state === 'function',
    'state',
    'must be a function returning the deploy state layer (e.g. () => prismaState())',
  );

  return loaded as PrismaAppConfig;
}

/**
 * Loads + validates the config at `configPath` via c12 (explicit file; rc /
 * global-rc / package.json lookups disabled — discovery already happened in
 * findConfigPathForEntry).
 */
export async function loadAppConfig(configPath: string): Promise<LoadedAppConfig> {
  const result = await c12LoadConfig({
    name: 'prisma-app',
    configFile: configPath,
    cwd: path.dirname(configPath),
    rcFile: false,
    globalRc: false,
    packageJson: false,
  });

  if (result.configFile !== configPath) {
    throw new CliError(
      `Config loading resolved "${String(result.configFile)}" instead of the discovered ` +
        `"${configPath}" — refusing to deploy against a different file.`,
    );
  }

  return { path: configPath, config: validateConfigShape(result.config, configPath) };
}

export type { ExtensionDescriptor, PrismaAppConfig };
