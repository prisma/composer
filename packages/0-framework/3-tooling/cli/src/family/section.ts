/**
 * Composer's projection into `prisma.config.ts` — the `composer` section.
 *
 * The section is deliberately tiny. Composer's real configuration lives in
 * `prisma-composer.config.ts`, which holds executable values (Effect layers,
 * provider factories, container lifecycles) and can only be understood by
 * evaluating it inside a running command. A config-section validator loads
 * with the command tree at start-up and must be dependency-light and total,
 * so it is the wrong place to evaluate any of that. What the section carries
 * is therefore only the one fact the engine can usefully know before a
 * command runs: WHERE that file is, when the user wants to say so.
 *
 * Its fields grow only by amending the slice contract.
 */
import {
  type ConfigSection,
  defineConfigSection,
  type SectionValidation,
} from '@prisma/cli-engine';
import type { Diagnostic } from '@prisma/cli-engine/protocol';

export interface ComposerSection {
  /**
   * Path to `prisma-composer.config.ts`, absolute or relative to the process
   * cwd. Absent — the common case — means composer searches upward from the
   * command's entry argument, as it always has.
   */
  readonly configPath?: string | undefined;
}

const KNOWN_FIELDS: readonly string[] = ['configPath'];

function diagnostic(spec: {
  code: `${string}.${string}`;
  severity: Diagnostic['severity'];
  summary: string;
  why?: string;
  fix?: string;
}): Diagnostic {
  return {
    code: spec.code,
    severity: spec.severity,
    summary: spec.summary,
    ...(spec.why === undefined ? {} : { why: spec.why }),
    nextActions: spec.fix === undefined ? [] : [{ kind: 'edit-file' as const, label: spec.fix }],
  };
}

function validate(raw: unknown): SectionValidation<ComposerSection> {
  // Absence is normal and is the validator's to own: with no section,
  // composer walks up from the entry exactly as it does today.
  if (raw === undefined) return { ok: true, value: {}, diagnostics: [] };

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      ok: false,
      diagnostics: [
        diagnostic({
          code: 'CONFIG.FIELD_INVALID',
          severity: 'error',
          summary: 'The `composer` section of prisma.config.ts must be an object.',
          fix: 'Write `composer: { configPath: "./prisma-composer.config.ts" }`, or remove the section entirely.',
        }),
      ],
    };
  }

  const record: Record<string, unknown> = { ...raw };
  const configPath = record['configPath'];
  if (configPath !== undefined && (typeof configPath !== 'string' || configPath.length === 0)) {
    return {
      ok: false,
      diagnostics: [
        diagnostic({
          code: 'CONFIG.FIELD_INVALID',
          severity: 'error',
          summary: '`composer.configPath` must be a non-empty string.',
          why: 'It names the prisma-composer.config.ts file to load.',
          fix: 'Set it to a path, or remove it to search upward from the entry.',
        }),
      ],
    };
  }

  // An unrecognized field is a warning, not a failure: the section's fields
  // grow by contract amendment, so a config written for a newer composer must
  // still run on this one. A warning on an ok validation reaches stderr and
  // nothing else, which is the right weight for "you may have typed this".
  const unknown = Object.keys(record).filter((key) => !KNOWN_FIELDS.includes(key));

  return {
    ok: true,
    value: configPath === undefined ? {} : { configPath },
    diagnostics: unknown.map((key) =>
      diagnostic({
        code: 'CONFIG.FIELD_UNKNOWN',
        severity: 'warn',
        summary: `The \`composer\` section has no field \`${key}\`; it is ignored.`,
        fix: `Remove \`${key}\`, or check it against the version of @prisma/composer you have installed.`,
      }),
    ),
  };
}

export const composerSection: ConfigSection<ComposerSection> = defineConfigSection<ComposerSection>(
  { name: 'composer', validate },
);
