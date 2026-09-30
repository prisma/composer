/**
 * The `composer` section of `prisma.config.ts` is Composer's whole configuration.
 * The validator checks only the fields that identify each descriptor and hands the descriptors to the command as the config file's own objects.
 */

import type { ExtensionDescriptor, PrismaAppConfig, StateDescriptor } from '@internal/core/config';
import type { ConfigSection, SectionProvenance, SectionValidation } from '@prisma/cli-engine';
import { defineConfigSection } from '@prisma/cli-engine';
import type { Diagnostic } from '@prisma/cli-engine/protocol';

const KNOWN_FIELDS: readonly string[] = ['extensions', 'state'];

const SECTION_FIX =
  "Write `composer: composer({ extensions: [...], state: ... })` in prisma.config.ts, with `import { defineConfig as composer } from '@prisma/composer/config'`.";

/** How to replace a prisma-composer.config.ts with the `composer` section. */
export const MOVE_TO_SECTION_FIX = `${SECTION_FIX} If the project has a prisma-composer.config.ts, move its extensions and state into that section and delete the file.`;

export const CONFIGURATION_HOME =
  'Composer reads its configuration only from the `composer` section of prisma.config.ts.';

const DESCRIPTOR_FIX =
  'Use the descriptor the extension factory returns, unchanged, instead of building one by hand.';

function diagnostic(spec: {
  code: `CONFIG.${string}`;
  summary: string;
  why?: string;
  fix: string;
  file: string | undefined;
  field?: string;
}): Diagnostic {
  return {
    code: spec.code,
    severity: 'error',
    summary: spec.summary,
    ...(spec.why === undefined ? {} : { why: spec.why }),
    nextActions: [{ kind: 'edit-file', label: spec.fix }],
    ...(spec.file === undefined ? {} : { where: { path: spec.file } }),
    ...(spec.field === undefined ? {} : { meta: { field: spec.field } }),
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

function missingSection(): SectionValidation<PrismaAppConfig> {
  return {
    ok: false,
    diagnostics: [
      diagnostic({
        code: 'CONFIG.SECTION_MISSING',
        summary: 'prisma.config.ts has no `composer` section.',
        why: `${CONFIGURATION_HOME} A prisma-composer.config.ts file is no longer read.`,
        fix: MOVE_TO_SECTION_FIX,
        file: undefined,
      }),
    ],
  };
}

function legacyConfigPath(file: string | undefined): Diagnostic {
  return diagnostic({
    code: 'CONFIG.LEGACY_FIELD',
    summary:
      '`composer.configPath` is no longer supported: prisma-composer.config.ts is no longer read.',
    why: CONFIGURATION_HOME,
    fix: `Replace \`configPath\` with the contents of prisma-composer.config.ts. ${SECTION_FIX} Then delete prisma-composer.config.ts.`,
    file,
    field: 'configPath',
  });
}

function validateExtensions(
  value: unknown,
  file: string | undefined,
): { diagnostics: Diagnostic[]; extensions: ExtensionDescriptor[] } {
  if (!Array.isArray(value)) {
    return {
      extensions: [],
      diagnostics: [
        diagnostic({
          code: 'CONFIG.FIELD_INVALID',
          summary: '`composer.extensions` must be an array of extension descriptors.',
          fix: 'Set `extensions` to the descriptors your extensions provide, e.g. `extensions: [nodeBuild()]`.',
          file,
          field: 'extensions',
        }),
      ],
    };
  }

  const diagnostics: Diagnostic[] = [];
  const extensions: ExtensionDescriptor[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    const field = `extensions[${index}]`;
    if (!isObject(entry)) {
      diagnostics.push(
        diagnostic({
          code: 'CONFIG.FIELD_INVALID',
          summary: `\`composer.${field}\` must be an extension descriptor object.`,
          fix: 'Put the descriptor an extension factory returns here, e.g. `nodeBuild()`, not the factory itself.',
          file,
          field,
        }),
      );
      continue;
    }
    const id = entry['id'];
    if (typeof id !== 'string' || id.length === 0) {
      diagnostics.push(
        diagnostic({
          code: 'CONFIG.FIELD_INVALID',
          summary: `\`composer.${field}.id\` must be a non-empty string (the extension package name).`,
          fix: DESCRIPTOR_FIX,
          file,
          field: `${field}.id`,
        }),
      );
    } else if (seen.has(id)) {
      diagnostics.push(
        diagnostic({
          code: 'CONFIG.EXTENSION_DUPLICATE',
          summary: `Extension "${id}" is listed more than once in \`composer.extensions\`.`,
          fix: `Remove the repeated "${id}" entry from \`extensions\`.`,
          file,
          field: `${field}.id`,
        }),
      );
    } else {
      seen.add(id);
    }
    if (!isObject(entry['nodes'])) {
      diagnostics.push(
        diagnostic({
          code: 'CONFIG.FIELD_INVALID',
          summary: `\`composer.${field}.nodes\` must be an object (the node-ID → control registry).`,
          fix: DESCRIPTOR_FIX,
          file,
          field: `${field}.nodes`,
        }),
      );
    }
    if (isExtensionDescriptor(entry)) extensions.push(entry);
  }
  return { diagnostics, extensions };
}

function validateSection(
  section: Record<string, unknown>,
  file: string | undefined,
): SectionValidation<PrismaAppConfig> {
  if (Object.hasOwn(section, 'configPath')) {
    return { ok: false, diagnostics: [legacyConfigPath(file)] };
  }

  const diagnostics: Diagnostic[] = Object.keys(section)
    .filter((key) => !KNOWN_FIELDS.includes(key))
    .map((key) =>
      diagnostic({
        code: 'CONFIG.FIELD_UNKNOWN',
        summary: `The \`composer\` section has no field \`${key}\`.`,
        fix: `Remove \`${key}\`. The section takes only \`extensions\` and \`state\`.`,
        file,
        field: key,
      }),
    );

  const { diagnostics: extensionDiagnostics, extensions } = validateExtensions(
    section['extensions'],
    file,
  );
  diagnostics.push(...extensionDiagnostics);

  const state = section['state'];
  const validState = isStateDescriptor(state);
  if (!validState) {
    diagnostics.push(
      diagnostic({
        code: 'CONFIG.FIELD_INVALID',
        summary:
          '`composer.state` must be a state descriptor with a string `extension` and a `create` function.',
        fix: 'Set `state` to the state descriptor an extension provides, e.g. `state: prismaState()`.',
        file,
        field: 'state',
      }),
    );
  }

  if (!validState || diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true, value: { extensions, state }, diagnostics: [] };
}

function validate(raw: unknown, provenance: SectionProvenance): SectionValidation<PrismaAppConfig> {
  if (raw === undefined) return missingSection();

  const file = provenance.files[0];
  if (!isObject(raw)) {
    return {
      ok: false,
      diagnostics: [
        diagnostic({
          code: 'CONFIG.FIELD_INVALID',
          summary: 'The `composer` section of prisma.config.ts must be an object.',
          fix: SECTION_FIX,
          file,
        }),
      ],
    };
  }

  // The section's values are user code: a Proxy trap or a getter can throw,
  // and the engine reports a throwing validator as a bug in composer.
  try {
    return validateSection({ ...raw }, file);
  } catch (cause) {
    return {
      ok: false,
      diagnostics: [
        diagnostic({
          code: 'CONFIG.FIELD_INVALID',
          summary: 'The `composer` section of prisma.config.ts could not be read.',
          why: `Reading it threw: ${cause instanceof Error ? cause.message : String(cause)}`,
          fix: SECTION_FIX,
          file,
        }),
      ],
    };
  }
}

export const composerSection: ConfigSection<PrismaAppConfig> = defineConfigSection<PrismaAppConfig>(
  {
    name: 'composer',
    validate,
    merge: (_parent, child) => child,
  },
);
