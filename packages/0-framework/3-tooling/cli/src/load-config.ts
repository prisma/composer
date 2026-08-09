/**
 * Pipeline step: find and load `prisma-composer.config.ts` (ADR-0017) — the ONE
 * file that imports control-plane code. Discovery is the standard walk-up
 * from the deploy entry's directory (mirrors prisma-next's config-loader);
 * loading is c12 with that explicit path (rc/global/package.json lookups
 * disabled), so the config file's own static imports resolve from the app
 * root by whatever package manager runs — no specifier construction, no
 * anchoring.
 *
 * Loading never throws on an invalid config: `loadAppConfig` returns the
 * evaluated value plus a DIAGNOSTICS list — every problem found, each a
 * structured error tagged (via `meta.section`/`meta.field`) with the config
 * section it concerns. A command fails only on the sections it needs
 * (`requireConfigSections`), so e.g. an invalid `state` never blocks a
 * command that only reads `extensions`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ExtensionDescriptor, PrismaAppConfig } from '@internal/core/config';
import { blindCast } from '@internal/foundation/casts';
import { CliStructuredError } from '@internal/foundation/errors';
import * as c12 from 'c12';

export const CONFIG_FILENAME = 'prisma-composer.config.ts';

/** The config sections a command can require. A diagnostic without a section is fatal for every command (the config as a whole is unusable). */
export type ConfigSection = 'extensions' | 'state';

export interface LoadedAppConfig {
  /** The discovered config file's absolute path — the generated stack file imports it by a path relative to itself. */
  readonly path: string;
  /** The evaluated default export, when evaluation produced a non-empty object; undefined when the module could not be evaluated or exported nothing. */
  readonly value: Record<string, unknown> | undefined;
  /** Every problem found while loading and validating, in source order. Empty means the whole config is valid. */
  readonly diagnostics: readonly CliStructuredError[];
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

function fieldDiagnostic(
  section: ConfigSection,
  field: string,
  requirement: string,
): CliStructuredError {
  return new CliStructuredError(
    'CONFIG.FIELD_INVALID',
    `${CONFIG_FILENAME}: \`${field}\` ${requirement}.`,
    {
      fix: "See defineConfig() in '@prisma/composer/config'.",
      meta: { section, field },
    },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Field-by-field validation of the loaded default export — deliberately no
 * schema library: EVERY failed check becomes a structured diagnostic naming
 * the offending field and its section, collected rather than thrown, so one
 * bad field never hides the next.
 */
export function collectConfigDiagnostics(
  loaded: unknown,
  configPath: string,
): CliStructuredError[] {
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
    diagnostics.push(fieldDiagnostic('extensions', 'extensions', 'must be an array'));
  } else {
    const seen = new Set<string>();
    for (const [index, entry] of extensions.entries()) {
      if (!isRecord(entry)) {
        diagnostics.push(
          fieldDiagnostic(
            'extensions',
            `extensions[${index}]`,
            'must be an extension descriptor object',
          ),
        );
        continue;
      }
      const id = entry['id'];
      if (typeof id !== 'string' || id.length === 0) {
        diagnostics.push(
          fieldDiagnostic(
            'extensions',
            `extensions[${index}].id`,
            'must be a non-empty string (the extension package name)',
          ),
        );
      }
      if (!isRecord(entry['nodes'])) {
        diagnostics.push(
          fieldDiagnostic(
            'extensions',
            `extensions[${index}].nodes`,
            'must be an object (the node-ID → control registry)',
          ),
        );
      }
      if (typeof id === 'string' && id.length > 0) {
        if (seen.has(id)) {
          diagnostics.push(
            new CliStructuredError(
              'CONFIG.EXTENSION_DUPLICATE',
              `${CONFIG_FILENAME}: extension "${id}" is listed more than once in \`extensions\`.`,
              { meta: { section: 'extensions', field: `extensions[${index}].id` } },
            ),
          );
        }
        seen.add(id);
      }
    }
  }

  const state = loaded['state'];
  if (
    !isRecord(state) ||
    typeof state['extension'] !== 'string' ||
    typeof state['create'] !== 'function'
  ) {
    diagnostics.push(
      fieldDiagnostic('state', 'state', 'must be a state descriptor (e.g. prismaState())'),
    );
  }

  return diagnostics;
}

/**
 * The one failure a command raises for the config problems it cannot proceed
 * past: a single diagnostic surfaces as itself (its own code stays the
 * branching surface); several combine into one `CONFIG.INVALID` whose
 * `meta.issues` lists every diagnostic — the shared envelope idiom
 * (prisma/prisma's `meta.issues`/`meta.conflicts`), which render-error.ts
 * renders as an indented list.
 */
export function combinedConfigFailure(
  diagnostics: readonly CliStructuredError[],
  configPath: string,
): CliStructuredError {
  const [first] = diagnostics;
  if (first === undefined) {
    throw new Error('combinedConfigFailure() needs at least one diagnostic');
  }
  if (diagnostics.length === 1) return first;
  return new CliStructuredError(
    'CONFIG.INVALID',
    `${CONFIG_FILENAME} has ${String(diagnostics.length)} problems.`,
    {
      fix: 'Fix each issue below.',
      where: { path: configPath },
      meta: {
        issues: diagnostics.map((diagnostic) => ({
          kind: diagnostic.code,
          message: diagnostic.message,
        })),
      },
    },
  );
}

/** True for a diagnostic that concerns `section` — or concerns the config as a whole (no `meta.section`), which no command can proceed past. */
function concernsSections(
  diagnostic: CliStructuredError,
  sections: readonly ConfigSection[],
): boolean {
  const section = diagnostic.meta?.['section'];
  if (typeof section !== 'string') return true;
  return sections.includes(
    blindCast<
      ConfigSection,
      'only the two ConfigSection literals are ever written to meta.section (fieldDiagnostic and the duplicate check above); an unknown string would only make includes() false, treating the diagnostic as out of scope'
    >(section),
  );
}

/**
 * The value, typed — after throwing `combinedConfigFailure` if any diagnostic
 * concerns one of `sections` (or the config as a whole). A caller must list
 * every section it will read: an unlisted section may hold anything.
 */
export function requireConfigSections(
  loaded: LoadedAppConfig,
  sections: readonly ConfigSection[],
): PrismaAppConfig {
  const relevant = loaded.diagnostics.filter((diagnostic) =>
    concernsSections(diagnostic, sections),
  );
  if (relevant.length > 0) {
    throw combinedConfigFailure(relevant, loaded.path);
  }
  return blindCast<
    PrismaAppConfig,
    'collectConfigDiagnostics validated the runtime shape of every requested section (extensions array with string ids + object registries, state a descriptor with a create function), and the caller contract above bars reading unrequested sections; the descriptors inside each registry cannot be structurally checked at runtime'
  >(loaded.value);
}

/**
 * Loads the config at `configPath` via c12 (explicit file; rc / global-rc /
 * package.json lookups disabled — discovery already happened in
 * findConfigPathForEntry) and validates its shape. Problems come back as
 * DIAGNOSTICS on the returned value — this function does not throw for an
 * invalid, unevaluatable, or missing-export config.
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
    // knows which file was evaluated (base-type rule 6). One sectionless
    // diagnostic: with no evaluated value, every command must fail early.
    return {
      path: configPath,
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
    typeof loadedFile !== 'string' ||
    fs.realpathSync(loadedFile) !== fs.realpathSync(configPath)
  ) {
    return {
      path: configPath,
      value: undefined,
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

  const diagnostics = collectConfigDiagnostics(result.config, configPath);
  return {
    path: configPath,
    value: isRecord(result.config) ? result.config : undefined,
    diagnostics,
  };
}

export type { ExtensionDescriptor, PrismaAppConfig };
