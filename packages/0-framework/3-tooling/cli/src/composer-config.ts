/**
 * What makes a `composer` section valid, shared by the CLI's section validator and the programmatic operations.
 * It imports nothing from the CLI engine, because `@prisma/composer` must not depend on it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ExtensionDescriptor, PrismaAppConfig, StateDescriptor } from '@internal/core/config';

/** Composer's configuration and the `prisma.config.ts` that declares it. */
export interface ComposerConfigSource {
  /** The `composer` section: the `composer` property of that file's default export. */
  readonly value: PrismaAppConfig;
  /** The declaring `prisma.config.ts`. The deploy's generated stack file imports it. A relative path resolves against the operation's `cwd`. */
  readonly file: string;
}

/** One reason a `composer` section or its file is refused. */
export interface ConfigFinding {
  readonly code: `CONFIG.${string}`;
  readonly summary: string;
  readonly why?: string;
  readonly fix: string;
  readonly field?: string;
  /** The file the finding is about, when it is not the declaring `prisma.config.ts`. */
  readonly where?: string;
}

const SECTION_FIX =
  "Write `composer: composer({ extensions: [...], state: ... })` in prisma.config.ts, with `import { defineConfig as composer } from '@prisma/composer/config'`.";

const MOVE_TO_SECTION_FIX = `${SECTION_FIX} If the project has a prisma-composer.config.ts, move its extensions and state into that section and delete the file.`;

const SECTION_IS_THE_ONLY_SOURCE =
  'Composer reads its configuration only from the `composer` section of prisma.config.ts.';

const DESCRIPTOR_FIX =
  'Use the descriptor the extension factory returns, unchanged, instead of building one by hand.';

const RETIRED_FILE_NAMES = ['ts', 'mts', 'mjs', 'js'].map(
  (extension) => `prisma-composer.config.${extension}`,
);

export const sectionMissing: ConfigFinding = {
  code: 'CONFIG.SECTION_MISSING',
  summary: 'No loaded prisma.config.ts declares a `composer` section.',
  why: `${SECTION_IS_THE_ONLY_SOURCE} A prisma-composer.config.ts file is no longer read.`,
  fix: MOVE_TO_SECTION_FIX,
};

export function configFileMissing(file: string): ConfigFinding {
  return {
    code: 'CONFIG.FILE_MISSING',
    summary: `${file} does not exist.`,
    fix: 'Pass the path of the prisma.config.ts that declares the `composer` section.',
    where: file,
  };
}

/** A prisma-composer.config.* beside the declaring file would otherwise be silently ignored. */
export function retiredFileFinding(configFile: string): ConfigFinding | undefined {
  const directory = path.dirname(configFile);
  const found = RETIRED_FILE_NAMES.map((name) => path.join(directory, name)).find((file) =>
    fs.existsSync(file),
  );
  if (found === undefined) return undefined;
  return {
    code: 'CONFIG.FILE_RETIRED',
    summary: `${found} is no longer read.`,
    why: SECTION_IS_THE_ONLY_SOURCE,
    fix: MOVE_TO_SECTION_FIX,
    where: found,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isExtensionDescriptor(value: unknown): value is ExtensionDescriptor {
  return (
    isObject(value) &&
    typeof value['id'] === 'string' &&
    value['id'].length > 0 &&
    isObject(value['nodes'])
  );
}

function isStateDescriptor(value: unknown): value is StateDescriptor {
  return (
    isObject(value) &&
    typeof value['extension'] === 'string' &&
    typeof value['create'] === 'function'
  );
}

const stateInvalid: ConfigFinding = {
  code: 'CONFIG.FIELD_INVALID',
  summary:
    '`composer.state` must be a state descriptor with a string `extension` and a `create` function.',
  fix: 'Set `state` to the state descriptor an extension provides, e.g. `state: prismaState()`.',
  field: 'state',
};

function unknownField(key: string): ConfigFinding {
  return {
    code: 'CONFIG.FIELD_UNKNOWN',
    summary: `The \`composer\` section has no field \`${key}\`.`,
    fix:
      key === 'composer'
        ? 'Pass the `composer` property of the prisma.config.ts export, not the whole export. The section takes only `extensions` and `state`.'
        : `Remove \`${key}\`. The section takes only \`extensions\` and \`state\`.`,
    field: key,
  };
}

function checkExtensions(value: unknown): {
  findings: ConfigFinding[];
  extensions: ExtensionDescriptor[];
} {
  if (!Array.isArray(value)) {
    return {
      extensions: [],
      findings: [
        {
          code: 'CONFIG.FIELD_INVALID',
          summary: '`composer.extensions` must be an array of extension descriptors.',
          fix: 'Set `extensions` to the descriptors your extensions provide, e.g. `extensions: [nodeBuild()]`.',
          field: 'extensions',
        },
      ],
    };
  }

  const findings: ConfigFinding[] = [];
  const extensions: ExtensionDescriptor[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    const field = `extensions[${index}]`;
    if (!isObject(entry)) {
      findings.push({
        code: 'CONFIG.FIELD_INVALID',
        summary: `\`composer.${field}\` must be an extension descriptor object.`,
        fix: 'Put the descriptor an extension factory returns here, e.g. `nodeBuild()`, not the factory itself.',
        field,
      });
      continue;
    }
    const id = entry['id'];
    if (typeof id !== 'string' || id.length === 0) {
      findings.push({
        code: 'CONFIG.FIELD_INVALID',
        summary: `\`composer.${field}.id\` must be a non-empty string (the extension package name).`,
        fix: DESCRIPTOR_FIX,
        field: `${field}.id`,
      });
    } else if (seen.has(id)) {
      findings.push({
        code: 'CONFIG.EXTENSION_DUPLICATE',
        summary: `Extension "${id}" is listed more than once in \`composer.extensions\`.`,
        fix: `Remove the repeated "${id}" entry from \`extensions\`.`,
        field: `${field}.id`,
      });
    } else {
      seen.add(id);
    }
    if (!isObject(entry['nodes'])) {
      findings.push({
        code: 'CONFIG.FIELD_INVALID',
        summary: `\`composer.${field}.nodes\` must be an object (the node-ID → control registry).`,
        fix: DESCRIPTOR_FIX,
        field: `${field}.nodes`,
      });
    }
    if (isExtensionDescriptor(entry)) extensions.push(entry);
  }
  return { findings, extensions };
}

function checkFields(section: Record<string, unknown>): CheckedSection {
  if (Object.hasOwn(section, 'configPath')) {
    return {
      ok: false,
      findings: [
        {
          code: 'CONFIG.FIELD_RETIRED',
          summary:
            '`composer.configPath` is no longer supported: prisma-composer.config.ts is no longer read.',
          why: SECTION_IS_THE_ONLY_SOURCE,
          fix: `Replace \`configPath\` with the section itself. ${MOVE_TO_SECTION_FIX}`,
          field: 'configPath',
        },
      ],
    };
  }

  if (Object.hasOwn(section, 'composer'))
    return { ok: false, findings: [unknownField('composer')] };

  const findings = Object.keys(section)
    .filter((key) => key !== 'extensions' && key !== 'state')
    .map(unknownField);

  const checked = checkExtensions(section['extensions']);
  findings.push(...checked.findings);

  const state = section['state'];
  if (!isStateDescriptor(state)) findings.push(stateInvalid);

  const [first, ...rest] = findings;
  if (first === undefined && isStateDescriptor(state)) {
    return { ok: true, value: { extensions: checked.extensions, state } };
  }
  return { ok: false, findings: [first ?? stateInvalid, ...rest] };
}

export type CheckedSection =
  | { readonly ok: true; readonly value: PrismaAppConfig }
  | { readonly ok: false; readonly findings: readonly [ConfigFinding, ...ConfigFinding[]] };

/**
 * Checks the fields that identify each descriptor and returns the descriptors as the config file's own objects.
 * Never throws: a section's values are user code, and a throwing getter or Proxy trap becomes a finding.
 */
export function checkComposerSection(raw: unknown): CheckedSection {
  if (!isObject(raw)) {
    return {
      ok: false,
      findings: [
        {
          code: 'CONFIG.FIELD_INVALID',
          summary: 'The `composer` section of prisma.config.ts must be an object.',
          fix: SECTION_FIX,
        },
      ],
    };
  }
  try {
    return checkFields({ ...raw });
  } catch (cause) {
    return {
      ok: false,
      findings: [
        {
          code: 'CONFIG.FIELD_INVALID',
          summary: 'The `composer` section of prisma.config.ts could not be read.',
          why: `Reading it threw: ${cause instanceof Error ? cause.message : String(cause)}`,
          fix: SECTION_FIX,
        },
      ],
    };
  }
}
