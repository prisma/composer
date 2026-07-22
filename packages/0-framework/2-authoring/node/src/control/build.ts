/**
 * The extension's control entry (ADR-0017): `nodeBuild()` returns the build
 * descriptor `prisma-composer.config.ts` lists. Deploy-only (ADR-0005): the user
 * builds their own runnable; `assemble` copies what they built under `bundle/`
 * and adds the framework's boot wrapper — it never bundles or transforms the
 * app's code.
 *
 * Two forms, chosen by the descriptor: without `dir`, `entry` is a single
 * self-contained file and only that file is copied. With `dir`, the whole
 * directory is copied verbatim and `entry` names the file inside it that boots.
 * Neither form discovers anything — no tree-walking for an entry, no filename
 * heuristics; the author states the paths and we copy exactly those.
 *
 * The wrapper is a SEPARATE esbuild build of the service module (declarations
 * only, whose node carries run()/load()), emitted as `main.mjs` at the
 * working-dir root — a dictated name (object entry `{ main }`), not a
 * discovered one. run() and the app entry must be independent module instances
 * that hand off through process.env, so the wrapper is its own self-contained
 * build; `@prisma/*` is inlined, `bun` is a Compute built-in.
 *
 * Artifact layout: `<cwd>/.prisma-composer/artifacts/<address>/` (deploy-owned,
 * ADR-0005) holds `main.mjs` at the root and the app's built runnable under
 * `bundle/`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BuildAdapter } from '@internal/core';
import type { ExtensionDescriptor } from '@internal/core/config';
import type { AssembleInput, Bundle } from '@internal/core/deploy';
import type { NodeBuildAdapter } from '../node.ts';
import { assertOutsideWorkDir, buildWrapper, resolveDir } from './assemble-shared.ts';

export type { AssembleInput, Bundle } from '@internal/core/deploy';

/** Narrows the shared BuildAdapter to this extension's own descriptor — the value-level mirror of the registry routing on (extension, type). `dir` is optional: absent is the single-file form. */
function isNodeBuild(descriptor: BuildAdapter): descriptor is NodeBuildAdapter {
  return (
    descriptor.type === 'node' && (!('dir' in descriptor) || typeof descriptor.dir === 'string')
  );
}

/** What the author built, resolved: the path copied under `bundle/`, and where the entry lands inside it. */
interface BuiltRunnable {
  /** The path copied verbatim under `bundle/` — the built directory, or the single built file. */
  readonly source: string;
  /** The descriptor field that named `source` — quoted back to the author in errors. */
  readonly sourceField: 'dir' | 'entry';
  /** The artifact's entry relative to `bundle/`, POSIX-separated (the Bundle contract). */
  readonly entry: string;
  /** The resolved, absolute entry file — the Bundle.watch input (ADR-0041). */
  readonly entryPath: string;
  /** Places `source` under `bundle/`, verbatim. */
  readonly copyInto: (bundleDir: string) => Promise<void>;
}

/** The single-file form: `entry` is the whole built runnable, resolved against dirname(module) (ADR-0004). */
function resolveFile(entrySpec: string, moduleDir: string): BuiltRunnable {
  const entryPath = path.resolve(moduleDir, entrySpec);
  if (!fs.existsSync(entryPath)) {
    throw new Error(
      `no built entry at ${entryPath} — run your build first (the build adapter's ` +
        `entry, "${entrySpec}", resolves against dirname(module)).`,
    );
  }
  const entryFile = path.basename(entryPath);
  return {
    source: entryPath,
    sourceField: 'entry',
    entry: entryFile,
    entryPath,
    copyInto: async (bundleDir) => {
      await fs.promises.mkdir(bundleDir, { recursive: true });
      await fs.promises.copyFile(entryPath, path.join(bundleDir, entryFile));
    },
  };
}

/**
 * The directory form: `dir` is the built tree, resolved against dirname(module)
 * (ADR-0004) and copied whole; `entry` resolves inside `dir` and names the file
 * that boots. An `entry` that resolves outside `dir` is rejected rather than
 * followed — only `dir` is ever copied. Validation and the symlink hard error
 * are shared with the `dir()` adapter (`./assemble-shared.ts`).
 */
async function resolveDirRunnable(
  dirSpec: string,
  entrySpec: string,
  moduleDir: string,
): Promise<BuiltRunnable> {
  const resolved = await resolveDir(dirSpec, entrySpec, moduleDir);
  return {
    source: resolved.dirPath,
    sourceField: 'dir',
    entry: resolved.entryRel,
    entryPath: resolved.entryPath,
    copyInto: (bundleDir) => fs.promises.cp(resolved.dirPath, bundleDir, { recursive: true }),
  };
}

export async function assemble(input: AssembleInput): Promise<Bundle> {
  if (!isNodeBuild(input.build)) {
    throw new Error(
      `@prisma/composer/node/control: expected a "node" build adapter, got "${input.build.type}".`,
    );
  }
  const buildDescriptor = input.build;

  const serviceModule = fileURLToPath(buildDescriptor.module);
  const moduleDir = path.dirname(serviceModule);
  const runnable =
    buildDescriptor.dir === undefined
      ? resolveFile(buildDescriptor.entry, moduleDir)
      : await resolveDirRunnable(buildDescriptor.dir, buildDescriptor.entry, moduleDir);

  const workDir = path.join(input.cwd, '.prisma-composer', 'artifacts', input.address);
  assertOutsideWorkDir(runnable.source, runnable.sourceField, workDir);

  await fs.promises.rm(workDir, { recursive: true, force: true });
  await fs.promises.mkdir(workDir, { recursive: true });

  await buildWrapper(serviceModule, workDir);

  await runnable.copyInto(path.join(workDir, 'bundle'));

  return {
    dir: workDir,
    entry: path.posix.join('bundle', runnable.entry),
    watch: [runnable.entryPath],
  };
}

/** The node build extension descriptor — `prisma-composer.config.ts` lists it under `extensions`. */
export const nodeBuild = (): ExtensionDescriptor => ({
  id: '@prisma/composer/node',
  nodes: {
    node: { kind: 'build', assemble },
  },
});
