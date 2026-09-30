import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PrismaAppConfig } from '@internal/core/config';
import { type LoadedConfigFile, resolveSectionOverChain } from '@prisma/cli-engine';
import { CliStructuredError, notOk, ok, type Result } from '@prisma/cli-engine/protocol';
import type { ComposerConfig } from '../pipeline.ts';
import { CONFIGURATION_HOME, composerSection, MOVE_TO_SECTION_FIX } from './section.ts';

const LEGACY_FILE_NAMES = ['ts', 'mts', 'mjs', 'js'].map(
  (extension) => `prisma-composer.config.${extension}`,
);

function legacyFileError(directory: string): CliStructuredError | undefined {
  const found = LEGACY_FILE_NAMES.map((name) => path.join(directory, name)).find((file) =>
    fs.existsSync(file),
  );
  if (found === undefined) return undefined;
  return new CliStructuredError('CONFIG.LEGACY_FILE', `${found} is no longer read.`, {
    why: CONFIGURATION_HOME,
    nextActions: [{ kind: 'edit-file', label: MOVE_TO_SECTION_FIX }],
    where: { path: found },
  });
}

/**
 * The validated `composer` section and the `prisma.config.ts` that declared it, as the operations take them.
 * Fails when a prisma-composer.config.* sits beside that file, since it would otherwise be silently ignored.
 */
export function composerConfigOf(ctx: {
  readonly config: PrismaAppConfig;
  readonly configFiles: readonly LoadedConfigFile[];
}): Result<ComposerConfig, CliStructuredError> {
  const resolved = resolveSectionOverChain(composerSection, ctx.configFiles);
  const declaringFile = resolved.ok ? resolved.provenance.files[0] : undefined;
  if (declaringFile === undefined) {
    throw new Error(
      'The composer section validated, but no loaded config file declares it on a second read.',
    );
  }
  const legacy = legacyFileError(path.dirname(declaringFile));
  if (legacy !== undefined) return notOk(legacy);
  return ok({ value: ctx.config, path: declaringFile });
}
