/**
 * Pipeline step 1 (deploy-cli.md § The pipeline): import the entry module
 * (resolved against cwd) and require its default export to be a node — a
 * service or module, branded by core's factories. Whatever this module exports
 * IS the application; nothing else marks a root (ADR-0003).
 */
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModuleNode, ServiceNode } from '@internal/core';
import { isNode } from '@internal/core';
import { blindCast } from '@internal/foundation/casts';
import { CliStructuredError } from '@internal/foundation/errors';
import { explainJsxLoadError } from './jsx-load-error.ts';

export interface LoadedEntry {
  /** The resolved absolute path to the entry module on disk. */
  readonly path: string;
  readonly root: ServiceNode | ModuleNode;
}

export async function loadEntry(entryArg: string, cwd: string): Promise<LoadedEntry> {
  const resolvedPath = path.resolve(cwd, entryArg);
  let mod: unknown;
  try {
    mod = await import(pathToFileURL(resolvedPath).href);
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
      { where: { path: resolvedPath }, cause: error },
    );
  }
  const root: unknown = blindCast<
    { default?: unknown },
    'a dynamically-imported module namespace object; only its default export is read here, and the isNode()/kind checks below are the real (runtime) guard on it'
  >(mod).default;

  if (!isNode(root) || root.kind === 'dependency' || root.kind === 'resource') {
    throw new CliStructuredError(
      'COMPOSE.ENTRY_EXPORT_INVALID',
      `Entry module "${resolvedPath}" must default-export a node (a service or a module).`,
      {
        fix: 'Construct it with service() or module() from @prisma/composer.',
        where: { path: resolvedPath },
      },
    );
  }

  return {
    path: resolvedPath,
    root: blindCast<
      ServiceNode | ModuleNode,
      "isNode() plus the kind check above prove root is a service or module node at runtime; isNode's return type (the branded ServiceNode | ResourceNode | DependencyEnd | ModuleNode union) structurally lacks each kind's own fields, so TS cannot narrow further on its own"
    >(root),
  };
}
