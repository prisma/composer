/**
 * Pipeline step: find and load `prisma-composer.config.ts` (ADR-0017) — the ONE
 * file that imports control-plane code. Discovery is the standard walk-up
 * from the deploy entry's directory (mirrors prisma-next's config-loader);
 * loading is c12 with that explicit path (rc/global/package.json lookups
 * disabled), so the config file's own static imports resolve from the app
 * root by whatever package manager runs — no specifier construction, no
 * anchoring. The loaded shape is validated field-by-field with structured
 * errors naming the field.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ExtensionDescriptor, PrismaAppConfig } from '@internal/core/config';
import { blindCast } from '@internal/foundation/casts';
import { CliStructuredError } from '@internal/foundation/errors';
import * as c12 from 'c12';

export const CONFIG_FILENAME = 'prisma-composer.config.ts';

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

export function missingConfigError(entryPath: string): CliStructuredError {
  const searchedFrom = path.dirname(path.resolve(entryPath));
  return new CliStructuredError(
    'CONFIG.FILE_MISSING',
    `No ${CONFIG_FILENAME} found walking up from "${searchedFrom}".`,
    {
      why: "The deploy needs the app's config file.",
      fix:
        'Create one next to (or above) the entry, default-exporting ' +
        "defineConfig({ extensions: [...], state: ... }) from '@prisma/composer/config'.",
      where: { path: searchedFrom },
    },
  );
}

function fieldError(field: string, requirement: string): CliStructuredError {
  return new CliStructuredError(
    'CONFIG.FIELD_INVALID',
    `${CONFIG_FILENAME}: \`${field}\` ${requirement}.`,
    {
      fix: "See defineConfig() in '@prisma/composer/config'.",
      meta: { field },
    },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Field-by-field validation of the loaded default export — deliberately no
 * schema library: each check is a structured error naming the offending field.
 * Returns the same object, typed.
 */
export function validateConfigShape(loaded: unknown, configPath: string): PrismaAppConfig {
  if (!isRecord(loaded) || Object.keys(loaded).length === 0) {
    throw new CliStructuredError('CONFIG.EXPORT_INVALID', `"${configPath}" exported no config.`, {
      fix:
        'It must default-export ' +
        "defineConfig({ extensions: [...], state: ... }) from '@prisma/composer/config'.",
      where: { path: configPath },
    });
  }

  const extensions = loaded['extensions'];
  if (!Array.isArray(extensions)) {
    throw fieldError('extensions', 'must be an array');
  }
  const seen = new Set<string>();
  for (const [index, entry] of extensions.entries()) {
    if (!isRecord(entry)) {
      throw fieldError(`extensions[${index}]`, 'must be an extension descriptor object');
    }
    const id = entry['id'];
    if (typeof id !== 'string' || id.length === 0) {
      throw fieldError(
        `extensions[${index}].id`,
        'must be a non-empty string (the extension package name)',
      );
    }
    if (!isRecord(entry['nodes'])) {
      throw fieldError(
        `extensions[${index}].nodes`,
        'must be an object (the node-ID → control registry)',
      );
    }
    if (seen.has(id)) {
      throw new CliStructuredError(
        'CONFIG.EXTENSION_DUPLICATE',
        `${CONFIG_FILENAME}: extension "${id}" is listed more than once in \`extensions\`.`,
      );
    }
    seen.add(id);
  }

  const state = loaded['state'];
  if (
    !isRecord(state) ||
    typeof state['extension'] !== 'string' ||
    typeof state['create'] !== 'function'
  ) {
    throw fieldError('state', 'must be a state descriptor (e.g. prismaState())');
  }

  return blindCast<
    PrismaAppConfig,
    'the field-by-field checks above validate the runtime shape (extensions array with string ids + object registries, state a function); the descriptors inside each registry cannot be structurally checked at runtime'
  >(loaded);
}

/**
 * Loads + validates the config at `configPath` via c12 (explicit file; rc /
 * global-rc / package.json lookups disabled — discovery already happened in
 * findConfigPathForEntry).
 */
export async function loadAppConfig(configPath: string): Promise<LoadedAppConfig> {
  let result: Awaited<ReturnType<typeof c12.loadConfig>>;
  try {
    result = await c12.loadConfig({
      name: 'prisma-composer',
      configFile: configPath,
      cwd: path.dirname(configPath),
      rcFile: false,
      globalRc: false,
      packageJson: false,
    });
  } catch (error) {
    // The config module's own evaluation threw (a missing env var, a syntax
    // error, a throwing factory) — structured here, at the one site that
    // knows which file was evaluated (base-type rule 6).
    throw new CliStructuredError(
      'CONFIG.EVALUATION_FAILED',
      `Evaluating "${configPath}" failed: ${error instanceof Error ? error.message : String(error)}`,
      { where: { path: configPath }, cause: error },
    );
  }

  const loadedFile = result.configFile;
  if (
    typeof loadedFile !== 'string' ||
    fs.realpathSync(loadedFile) !== fs.realpathSync(configPath)
  ) {
    throw new CliStructuredError(
      'CONFIG.PATH_MISMATCH',
      `Config loading resolved "${String(loadedFile)}" instead of the discovered "${configPath}".`,
      {
        why: 'Refusing to deploy against a different file.',
        where: { path: configPath },
      },
    );
  }

  return { path: configPath, config: validateConfigShape(result.config, configPath) };
}

export type { ExtensionDescriptor, PrismaAppConfig };
