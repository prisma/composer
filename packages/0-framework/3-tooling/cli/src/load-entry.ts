/**
 * Pipeline step 2 (deploy-cli.md § The pipeline): import the entry module
 * (resolved against cwd) and require its default export to be the app's root:
 * an app root built with `appRoot()`, or a module built with `module()`
 * (ADR-0003).
 */
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AppRootNode, ModuleNode } from '@internal/core';
import { isNode } from '@internal/core';
import { blindCast } from '@internal/foundation/casts';
import { CliStructuredError } from '@internal/foundation/errors';
import { recordAppFiles, registerEntryResolution } from './entry-resolution.ts';
import { explainJsxLoadError } from './jsx-load-error.ts';

export interface LoadedEntry {
  /** The resolved absolute path to the entry module on disk. */
  readonly path: string;
  readonly root: ModuleNode | AppRootNode;
  /** The app definition files: the entry and every other app file (outside `node_modules`) this import loaded for the first time. A later import of a cached entry yields only the entry. */
  readonly files: readonly string[];
}

/** `unloadableFix`, when given, says where the path came from, so a wrong path names its source. */
export async function loadEntry(
  entryArg: string,
  cwd: string,
  unloadableFix?: string,
): Promise<LoadedEntry> {
  registerEntryResolution();
  const resolvedPath = path.resolve(cwd, entryArg);
  let mod: unknown;
  let files: readonly string[];
  try {
    ({ value: mod, files } = await recordAppFiles(() => import(pathToFileURL(resolvedPath).href)));
  } catch (error) {
    const explained = explainJsxLoadError(error, resolvedPath);
    if (explained !== undefined) {
      throw new CliStructuredError('COMPOSE.ENTRY_UNLOADABLE', explained.summary, {
        why: explained.why,
        fix: explained.fix,
        where: { path: resolvedPath },
        cause: error,
      });
    }
    throw new CliStructuredError(
      'COMPOSE.ENTRY_UNLOADABLE',
      `Failed to import entry module "${resolvedPath}": ${error instanceof Error ? error.message : String(error)}`,
      {
        ...(unloadableFix === undefined ? {} : { fix: unloadableFix }),
        where: { path: resolvedPath },
        cause: error,
      },
    );
  }
  const root: unknown = blindCast<
    { default?: unknown },
    'a dynamically-imported module namespace object; only its default export is read here, and the isNode()/kind checks below are the real (runtime) guard on it'
  >(mod).default;

  if (isNode(root) && root.kind === 'service') {
    throw new CliStructuredError(
      'COMPOSE.ROOT_NOT_MODULE',
      `The entry "${resolvedPath}" default-exports a service. The app's root must be a module, built with appRoot().`,
      {
        fix: "Provision the service inside a root, e.g. export default appRoot('name', ({ provision }) => { provision(service); }).",
        where: { path: resolvedPath },
      },
    );
  }
  if (!isNode(root) || root.kind !== 'module') {
    throw new CliStructuredError(
      'COMPOSE.ENTRY_EXPORT_INVALID',
      `Entry module "${resolvedPath}" must default-export the app's root.`,
      {
        fix: 'Build it with appRoot() from @prisma/composer.',
        where: { path: resolvedPath },
      },
    );
  }

  return { path: resolvedPath, files: [...new Set([resolvedPath, ...files])], root };
}
