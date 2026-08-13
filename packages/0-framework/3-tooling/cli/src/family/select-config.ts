/**
 * Composer config precedence at the command-family boundary.
 *
 * A conventional prisma-composer.config.ts is Composer's complete config and
 * wins without evaluating prisma.config.ts. Only when no conventional file is
 * discoverable do we preserve the consolidated CLI's composer.configPath
 * fallback.
 */
import * as path from 'node:path';
import { type EngineEvent, loadConfig } from '@prisma/cli-engine';
import {
  CliStructuredError,
  type Diagnostic,
  notOk,
  ok,
  type Result,
} from '@prisma/cli-engine/protocol';
import { findConfigPathForEntry } from '../config-discovery.ts';
import { composerSection } from './section.ts';

export interface SelectedComposerConfig {
  /** Undefined tells Composer's pipeline to perform its normal entry-anchored discovery. */
  readonly configPath: string | undefined;
  readonly diagnostics: readonly Diagnostic[];
}

/** Preserves the engine's warning commentary for the legacy section fallback. */
export function reportConfigDiagnostics(
  diagnostics: readonly Diagnostic[],
  report: (event: EngineEvent) => void,
): void {
  for (const diagnostic of diagnostics) {
    report({
      kind: 'message',
      severity: diagnostic.severity === 'error' ? 'warn' : diagnostic.severity,
      text: diagnostic.summary,
    });
  }
}

function errorFromDiagnostic(
  diagnostic: Diagnostic,
  diagnostics: readonly Diagnostic[] = [],
): CliStructuredError {
  return new CliStructuredError(diagnostic.code, diagnostic.summary, {
    severity: diagnostic.severity,
    nextActions: diagnostic.nextActions,
    diagnostics,
    ...(diagnostic.why === undefined ? {} : { why: diagnostic.why }),
    ...(diagnostic.where === undefined ? {} : { where: diagnostic.where }),
    ...(diagnostic.meta === undefined ? {} : { meta: diagnostic.meta }),
    ...(diagnostic.docsUrl === undefined ? {} : { docsUrl: diagnostic.docsUrl }),
  });
}

/**
 * Selects Composer's config without touching prisma.config.ts when the
 * documented Composer config is present. The fallback mirrors the engine's
 * existing composer-section validation for projects that still use it.
 */
export async function selectComposerConfig(
  entry: string,
  cwd: string,
): Promise<Result<SelectedComposerConfig, CliStructuredError>> {
  const entryPath = path.resolve(cwd, entry);
  if (findConfigPathForEntry(entryPath) !== undefined) {
    return ok({ configPath: undefined, diagnostics: [] });
  }

  const loaded = await loadConfig(cwd);
  const fileDiagnostics = loaded.diagnostics
    .filter((entry) => entry.section === null)
    .map((entry) => entry.diagnostic);
  const [fileDiagnostic, ...additionalFileDiagnostics] = fileDiagnostics;
  if (fileDiagnostic !== undefined) {
    return notOk(errorFromDiagnostic(fileDiagnostic, additionalFileDiagnostics));
  }

  const validation = composerSection.validate(loaded.sections[composerSection.name]);
  if (!validation.ok) {
    return notOk(
      new CliStructuredError(
        'CLI.CONFIG_SECTION_INVALID',
        `The '${composerSection.name}' section of ${loaded.path} is invalid.`,
        {
          nextActions: [
            {
              kind: 'user-choice',
              label: 'Fix the reported problems in that section, then run the command again.',
            },
          ],
          diagnostics: validation.diagnostics,
        },
      ),
    );
  }

  return ok({ configPath: validation.value.configPath, diagnostics: validation.diagnostics });
}
