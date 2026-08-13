/**
 * Pipeline step: find and load `prisma-composer.config.ts` (ADR-0017) — the ONE
 * file that imports control-plane code. Discovery is the standard walk-up
 * from the deploy entry's directory (mirrors prisma-next's config-loader);
 * loading is c12 with that explicit path (rc/global/package.json lookups
 * disabled), so the config file's own static imports resolve from the app
 * root by whatever package manager runs — no specifier construction, no
 * anchoring.
 *
 * Two shapes of the same machinery remain available to the operation layer:
 *
 *   loadAppConfigDiagnostics — returns the evaluated value together with
 *   EVERY problem found, and never throws. Hosts that need to render all
 *   findings can consume this without losing later diagnostics.
 *
 *   loadAppConfig — the same load, throwing its first diagnostic. Composer's
 *   deploy/dev operations use this after config selection has settled.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ExtensionDescriptor, PrismaAppConfig } from '@internal/core/config';
import { blindCast } from '@internal/foundation/casts';
import { CliStructuredError } from '@internal/foundation/errors';
import * as c12 from 'c12';
import { effectResolutionDiagnostic } from './check-effect-resolution.ts';
import { CONFIG_FILENAME, findConfigPathForEntry } from './config-discovery.ts';

export { CONFIG_FILENAME, findConfigPathForEntry } from './config-discovery.ts';

export interface LoadedAppConfig {
  /** The discovered config file's absolute path — the generated stack file imports it by a path relative to itself. */
  readonly path: string;
  readonly config: PrismaAppConfig;
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
 *
 * Collects rather than throws, so one bad config reports every bad field
 * instead of only the first. The `extensions` and `state` checks are
 * independent, and within `extensions` each entry is judged on its own; a
 * field whose own shape check already failed is not probed further, because
 * anything derived from it would be noise rather than a second finding.
 */
export function configShapeDiagnostics(
  loaded: unknown,
  configPath: string,
): readonly CliStructuredError[] {
  if (!isRecord(loaded) || Object.keys(loaded).length === 0) {
    return [
      new CliStructuredError('CONFIG.EXPORT_INVALID', `"${configPath}" exported no config.`, {
        fix:
          'It must default-export ' +
          "defineConfig({ extensions: [...], state: ... }) from '@prisma/composer/config'.",
        where: { path: configPath },
      }),
    ];
  }

  const diagnostics: CliStructuredError[] = [];

  const extensions = loaded['extensions'];
  if (!Array.isArray(extensions)) {
    diagnostics.push(fieldError('extensions', 'must be an array'));
  } else {
    const seen = new Set<string>();
    for (const [index, entry] of extensions.entries()) {
      if (!isRecord(entry)) {
        diagnostics.push(
          fieldError(`extensions[${index}]`, 'must be an extension descriptor object'),
        );
        continue;
      }
      const id = entry['id'];
      if (typeof id !== 'string' || id.length === 0) {
        diagnostics.push(
          fieldError(
            `extensions[${index}].id`,
            'must be a non-empty string (the extension package name)',
          ),
        );
      } else if (seen.has(id)) {
        diagnostics.push(
          new CliStructuredError(
            'CONFIG.EXTENSION_DUPLICATE',
            `${CONFIG_FILENAME}: extension "${id}" is listed more than once in \`extensions\`.`,
          ),
        );
      } else {
        seen.add(id);
      }
      if (!isRecord(entry['nodes'])) {
        diagnostics.push(
          fieldError(
            `extensions[${index}].nodes`,
            'must be an object (the node-ID → control registry)',
          ),
        );
      }
    }
  }

  const state = loaded['state'];
  if (
    !isRecord(state) ||
    typeof state['extension'] !== 'string' ||
    typeof state['create'] !== 'function'
  ) {
    diagnostics.push(fieldError('state', 'must be a state descriptor (e.g. prismaState())'));
  }

  return diagnostics;
}

/** The throwing form of configShapeDiagnostics: raises the first finding, returns the same object typed. Used by the clipanion pipeline. */
export function validateConfigShape(loaded: unknown, configPath: string): PrismaAppConfig {
  const [first] = configShapeDiagnostics(loaded, configPath);
  if (first !== undefined) throw first;
  return blindCast<
    PrismaAppConfig,
    'the field-by-field checks above validate the runtime shape (extensions array with string ids + object registries, state a function); the descriptors inside each registry cannot be structurally checked at runtime'
  >(loaded);
}

/**
 * Evaluates `configPath` with c12 (explicit file; rc / global-rc /
 * package.json lookups disabled). `verifySamePath` runs the same-file check
 * against the discovered path — see loadAppConfigDiagnostics for when it does
 * not apply.
 */
async function evaluateConfig(
  configPath: string,
  verifySamePath: boolean,
): Promise<{ value: unknown; diagnostics: readonly CliStructuredError[] }> {
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
    // knows which file was evaluated (base-type rule 6). Nothing evaluated,
    // so there is no value and no shape to judge.
    return {
      value: undefined,
      diagnostics: [
        new CliStructuredError(
          'CONFIG.EVALUATION_FAILED',
          `Evaluating "${configPath}" failed: ${error instanceof Error ? error.message : String(error)}`,
          { where: { path: configPath }, cause: error },
        ),
      ],
    };
  }

  const loadedFile = result.configFile;
  if (
    verifySamePath &&
    (typeof loadedFile !== 'string' || fs.realpathSync(loadedFile) !== fs.realpathSync(configPath))
  ) {
    return {
      value: result.config,
      diagnostics: [
        new CliStructuredError(
          'CONFIG.PATH_MISMATCH',
          `Config loading resolved "${String(loadedFile)}" instead of the discovered "${configPath}".`,
          {
            why: 'Refusing to deploy against a different file.',
            where: { path: configPath },
          },
        ),
      ],
    };
  }

  return { value: result.config, diagnostics: configShapeDiagnostics(result.config, configPath) };
}

export interface ConfigLoadRequest {
  /** The command's entry argument. Anchors the walk when no explicit path is given. */
  readonly entryPath: string;
  /**
   * The `composer` config section's `configPath`, absolute or relative to
   * `cwd`. When present the section wins: the walk is skipped, and so is the
   * same-file check — that check exists to catch a walk finding one file while
   * c12 loaded another, and a path the user named directly has no walk to
   * disagree with.
   */
  readonly configPath?: string | undefined;
  /**
   * The directory the command runs in: it anchors a relative `configPath` and
   * is where the effect-resolution check looks for the installed tree.
   * Defaults to the entry's directory.
   */
  readonly cwd?: string | undefined;
}

/** Which file a load will use, or the one finding that stops it before any file is chosen. */
type ConfigSource =
  | { readonly ok: true; readonly path: string; readonly explicit: boolean }
  | {
      readonly ok: false;
      readonly path: string | undefined;
      readonly diagnostic: CliStructuredError;
    };

/**
 * The front of every config load, shared by the throwing and the
 * diagnostics-list shapes: verify the installed tree can evaluate a config at
 * all, then settle which file to load — the section's path, or the
 * entry-anchored walk.
 *
 * The effect-resolution check comes first because evaluating a config imports
 * alchemy's provider tree: in a tree where alchemy resolves an `effect` we did
 * not pin, nothing downstream can load, so the dependency conflict is the
 * finding with the fix in it and every later failure is its symptom.
 */
function configSource(request: ConfigLoadRequest): ConfigSource {
  const resolvedEntry = path.resolve(request.entryPath);
  const cwd = request.cwd ?? path.dirname(resolvedEntry);

  const effectConflict = effectResolutionDiagnostic(cwd);
  if (effectConflict !== undefined) {
    return { ok: false, path: undefined, diagnostic: effectConflict };
  }

  if (request.configPath === undefined) {
    const discovered = findConfigPathForEntry(resolvedEntry);
    return discovered === undefined
      ? { ok: false, path: undefined, diagnostic: missingConfigError(resolvedEntry) }
      : { ok: true, path: discovered, explicit: false };
  }

  const configPath = path.resolve(cwd, request.configPath);
  if (!fs.existsSync(configPath)) {
    return {
      ok: false,
      path: configPath,
      diagnostic: new CliStructuredError(
        'CONFIG.FILE_MISSING',
        `The \`composer\` config section points at "${configPath}", which does not exist.`,
        {
          why: 'An explicit configPath is used as given — there is no walk to fall back on.',
          fix: 'Correct `configPath` in the `composer` section of prisma.config.ts, or remove it to search upward from the entry.',
          where: { path: configPath },
        },
      ),
    };
  }
  return { ok: true, path: configPath, explicit: true };
}

/**
 * The throwing form of that front, for the pipeline: the file the load will
 * use, or the finding raised. `explicit` says the section named the file,
 * which is what retires the same-file check for that case.
 */
export function resolveConfigFile(request: ConfigLoadRequest): {
  readonly path: string;
  readonly explicit: boolean;
} {
  const source = configSource(request);
  if (!source.ok) throw source.diagnostic;
  return { path: source.path, explicit: source.explicit };
}

export interface ConfigLoadOutcome {
  /** The config file this load used; undefined when none was found. */
  readonly path: string | undefined;
  /** The evaluated default export. Undefined when evaluation produced nothing. */
  readonly value: unknown;
  /** Every problem found, in the order found. Empty means a clean load. */
  readonly diagnostics: readonly CliStructuredError[];
}

/**
 * Loads the app config and reports every problem instead of throwing the
 * first. Never throws.
 *
 * The effect-resolution check runs first and, when it fires, is the ONLY
 * diagnostic returned: a tree where alchemy resolves the wrong `effect`
 * cannot evaluate a config that imports alchemy's provider tree, so the
 * evaluation failure that would follow is a symptom of the finding already in
 * hand, and reporting both would bury the one with the fix in it.
 */
export async function loadAppConfigDiagnostics(
  request: ConfigLoadRequest,
): Promise<ConfigLoadOutcome> {
  const source = configSource(request);
  if (!source.ok) {
    return { path: source.path, value: undefined, diagnostics: [source.diagnostic] };
  }
  const { value, diagnostics } = await evaluateConfig(source.path, !source.explicit);
  return { path: source.path, value, diagnostics };
}

/**
 * Loads + validates the config at `configPath`, throwing its first diagnostic.
 * The clipanion CLI's pipeline runs on this; it goes when clipanion does.
 */
export async function loadAppConfig(
  configPath: string,
  verifySamePath = true,
): Promise<LoadedAppConfig> {
  const { value, diagnostics } = await evaluateConfig(configPath, verifySamePath);
  const [first] = diagnostics;
  if (first !== undefined) throw first;
  return { path: configPath, config: validateConfigShape(value, configPath) };
}

export type { ExtensionDescriptor, PrismaAppConfig };
