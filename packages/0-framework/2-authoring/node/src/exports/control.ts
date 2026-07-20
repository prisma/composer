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
import { build } from 'esbuild';
import type { NodeBuildAdapter } from './index.ts';

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
 * followed — only `dir` is ever copied.
 */
async function resolveDir(
  dirSpec: string,
  entrySpec: string,
  moduleDir: string,
): Promise<BuiltRunnable> {
  const dirPath = path.resolve(moduleDir, dirSpec);
  if (!fs.existsSync(dirPath)) {
    throw new Error(
      `no built directory at ${dirPath} — run your build first (the build adapter's ` +
        `dir, "${dirSpec}", resolves against dirname(module)).`,
    );
  }
  if (!fs.statSync(dirPath).isDirectory()) {
    throw new Error(
      `the build adapter's dir ("${dirPath}") is not a directory — drop dir to deploy a ` +
        'single built file, naming it as entry.',
    );
  }

  const entryPath = path.resolve(dirPath, entrySpec);
  if (!entryPath.startsWith(dirPath + path.sep)) {
    throw new Error(
      `the build adapter's entry ("${entrySpec}") resolves to ${entryPath}, which is not inside ` +
        `dir ("${dirPath}") — in the directory form entry names a file inside dir, and only dir is copied.`,
    );
  }
  if (!fs.existsSync(entryPath) || !fs.statSync(entryPath).isFile()) {
    throw new Error(
      `no built entry at ${entryPath} — run your build first (the build adapter's entry, ` +
        `"${entrySpec}", resolves inside dir, "${dirPath}").`,
    );
  }

  await assertNoSymlinks(dirPath);

  return {
    source: dirPath,
    sourceField: 'dir',
    entry: path.relative(dirPath, entryPath).split(path.sep).join('/'),
    copyInto: (bundleDir) => fs.promises.cp(dirPath, bundleDir, { recursive: true }),
  };
}

/**
 * Compute's packager rejects symlinks, so a tree containing one cannot deploy.
 * We fail here, naming the links, rather than dereferencing them on the copy:
 * the artifact must be what the author's build produced (ADR-0005), and
 * following a link that points outside `dir` would pull in files the author
 * never named. The walk reads dirents (lstat semantics), so a symlinked
 * directory is reported and never descended into.
 */
async function assertNoSymlinks(dirPath: string): Promise<void> {
  const found: string[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await fs.promises.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) found.push(full);
      else if (entry.isDirectory()) await walk(full);
    }
  };
  await walk(dirPath);

  if (found.length === 0) return;
  const listed = found.slice(0, 5).join(', ');
  throw new Error(
    `the build adapter's dir ("${dirPath}") contains symlinks, which the platform's packager ` +
      `rejects: ${listed}${found.length > 5 ? `, and ${found.length - 5} more` : ''}. The tree is ` +
      'copied verbatim, so make your build emit real files in dir (for example, a hoisted ' +
      'node_modules, or dereference the links into dir with cp -RL).',
  );
}

/**
 * The working dir is cleared on every assemble, so it must not overlap the copy
 * source: inside it, the rm would delete the source before the copy; the other
 * way round, the copy would recurse into its own output.
 */
function assertOutsideWorkDir(runnable: BuiltRunnable, workDir: string): void {
  const { source, sourceField } = runnable;
  if (source === workDir || source.startsWith(workDir + path.sep)) {
    throw new Error(
      `the build adapter's ${sourceField} ("${source}") resolves inside the deploy working dir ` +
        `("${workDir}"), which is cleared on every assemble — point ${sourceField} at your build output elsewhere.`,
    );
  }
  if (workDir.startsWith(source + path.sep)) {
    throw new Error(
      `the deploy working dir ("${workDir}") sits inside the build adapter's ${sourceField} ` +
        `("${source}"), so assembling would copy the artifact into itself — point ${sourceField} ` +
        'at your build output elsewhere.',
    );
  }
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
      : await resolveDir(buildDescriptor.dir, buildDescriptor.entry, moduleDir);

  const workDir = path.join(input.cwd, '.prisma-composer', 'artifacts', input.address);
  assertOutsideWorkDir(runnable, workDir);

  await fs.promises.rm(workDir, { recursive: true, force: true });
  await fs.promises.mkdir(workDir, { recursive: true });

  await build({
    entryPoints: { main: serviceModule },
    outdir: workDir,
    bundle: true,
    format: 'esm',
    platform: 'node',
    external: ['bun', 'bun:*'],
    outExtension: { '.js': '.mjs' },
  });
  if (!fs.existsSync(path.join(workDir, 'main.mjs'))) {
    throw new Error(`esbuild produced no main.mjs in ${workDir}`);
  }

  await runnable.copyInto(path.join(workDir, 'bundle'));

  return { dir: workDir, entry: path.posix.join('bundle', runnable.entry) };
}

/** The node build extension descriptor — `prisma-composer.config.ts` lists it under `extensions`. */
export const nodeBuild = (): ExtensionDescriptor => ({
  id: '@prisma/composer/node',
  nodes: {
    node: { kind: 'build', assemble },
  },
});
