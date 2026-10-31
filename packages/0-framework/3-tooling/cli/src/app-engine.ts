/**
 * Which copy of Composer's lowering and Alchemy runs `deploy`: the one the
 * app installs, found from the app directory the way the generated stack
 * file's own `@prisma/composer` imports are. The extension descriptors,
 * providers and state store come from that install too, through
 * `prisma.config.ts`, so the stack, the engine and the providers share one
 * copy of `alchemy` and `effect` even when the `prisma` host pins another
 * Composer version (ADR-0050, ADR-0064).
 */
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { lower } from '@internal/core/deploy';
import { blindCast } from '@internal/foundation/casts';
import { CliStructuredError } from '@internal/foundation/errors';
import type { Converge } from './converge-in-process.ts';

const ENTRY = '@prisma/composer/internal/converge';

/** Lowers the app and converges the stack: one install's `lower` and `convergeInProcess`. */
export interface DeployEngine {
  readonly lower: typeof lower;
  readonly converge: Converge;
}

function unresolvable(appDir: string, detail: string, cause?: unknown): CliStructuredError {
  return new CliStructuredError(
    'DEPS.ENGINE_UNRESOLVABLE',
    `Could not load the deploy engine from the app's @prisma/composer in "${appDir}": ${detail}`,
    {
      why: "`prisma deploy` runs the lowering and Alchemy from the app's own install of @prisma/composer, so the app, its extensions and the engine share one copy of alchemy.",
      fix: 'Install @prisma/composer in the app, at the same version as the Composer the `prisma` CLI runs, and deploy from the app directory.',
      ...(cause === undefined ? {} : { cause }),
    },
  );
}

/** The app's deploy engine. Raises DEPS.ENGINE_UNRESOLVABLE when the app's @prisma/composer is missing or predates the in-process converge. */
export async function loadAppEngine(appDir: string): Promise<DeployEngine> {
  let file: string;
  try {
    file = createRequire(path.join(appDir, 'package.json')).resolve(ENTRY);
  } catch (error) {
    throw unresolvable(appDir, `${ENTRY} does not resolve.`, error);
  }
  let loaded: Record<string, unknown>;
  try {
    loaded = await import(pathToFileURL(file).href);
  } catch (error) {
    throw unresolvable(
      appDir,
      `${file} failed to load: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
  const { lower: appLower, convergeInProcess } = loaded;
  if (typeof appLower !== 'function' || typeof convergeInProcess !== 'function') {
    throw unresolvable(appDir, `${file} exports no lower and convergeInProcess.`);
  }
  return blindCast<
    DeployEngine,
    "the typeof checks above prove both are functions; the entry is this package's own src/exports/converge.ts, built into the app's @prisma/composer"
  >({ lower: appLower, converge: convergeInProcess });
}
