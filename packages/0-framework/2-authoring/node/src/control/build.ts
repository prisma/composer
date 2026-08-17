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
 * The directory form also follows the declared entry's static runtime dependency
 * graph and stages those files from the deploy cwd beside the output. This is
 * deterministic dependency assembly (not app bundling), and is what makes
 * framework outputs such as Astro's Node adapter self-contained.
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
import { nodeFileTrace } from '@vercel/nft';
import { build } from 'esbuild';
import type { NodeBuildAdapter } from '../node.ts';

export type { AssembleInput, Bundle } from '@internal/core/deploy';

/** Narrows the shared BuildAdapter to this extension's own descriptor — the value-level mirror of the registry routing on (extension, type). `dir` is optional: absent is the single-file form. */
function isNodeBuild(descriptor: BuildAdapter): descriptor is NodeBuildAdapter {
  return (
    descriptor.type === 'node' && (!('dir' in descriptor) || typeof descriptor.dir === 'string')
  );
}

/**
 * What the author built, resolved: the path copied under `bundle/`, and
 * what `Bundle.watch` names for this form (ADR-0041) — the single-file form
 * watches the entry file itself; the directory form watches the whole `dir`,
 * since a rebuild may touch only a sibling the entry doesn't import.
 */
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
 *
 * `dir` itself can be a symlink — not just something inside it. `lstat` it
 * before anything else so that case hard-errors identically whether the link
 * points at a real directory (which a dereferencing `stat` would otherwise
 * accept as "is a directory") or at a file: neither is ever silently
 * dereferenced and copied (ADR-0005).
 */
async function resolveDir(
  dirSpec: string,
  entrySpec: string,
  moduleDir: string,
): Promise<BuiltRunnable> {
  const dirPath = path.resolve(moduleDir, dirSpec);

  let dirLstat: fs.Stats;
  try {
    dirLstat = await fs.promises.lstat(dirPath);
  } catch {
    throw new Error(
      `no built directory at ${dirPath} — run your build first (the build adapter's ` +
        `dir, "${dirSpec}", resolves against dirname(module)).`,
    );
  }
  if (dirLstat.isSymbolicLink()) {
    throw new Error(
      `the build adapter's dir ("${dirPath}") is itself a symlink — name the built directory directly. Nested links are preserved only after the final assembled bundle proves their targets stay inside it.`,
    );
  }
  if (!dirLstat.isDirectory()) {
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

  return {
    source: dirPath,
    sourceField: 'dir',
    entry: path.relative(dirPath, entryPath).split(path.sep).join('/'),
    copyInto: (bundleDir) =>
      fs.promises.cp(dirPath, bundleDir, { recursive: true, verbatimSymlinks: true }),
  };
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function commonAncestor(left: string, right: string): string {
  let candidate = path.resolve(left);
  const resolvedRight = path.resolve(right);
  while (!isInside(candidate, resolvedRight)) {
    const parent = path.dirname(candidate);
    if (parent === candidate) return candidate;
    candidate = parent;
  }
  return candidate;
}

async function copyTracedEntry(
  source: string,
  destination: string,
  traceBase: string,
  bundleDir: string,
  dirPath: string,
): Promise<void> {
  const stat = await fs.promises.lstat(source);
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });

  if (stat.isSymbolicLink()) {
    const realTarget = await fs.promises.realpath(source);
    if (!isInside(traceBase, realTarget)) {
      throw new Error(
        `the runtime dependency trace found a symlink outside its staging root: ${source} -> ${realTarget}`,
      );
    }
    const stagedTarget = isInside(dirPath, realTarget)
      ? path.join(bundleDir, path.relative(dirPath, realTarget))
      : path.join(bundleDir, path.relative(traceBase, realTarget));
    const linkTarget = path.relative(path.dirname(destination), stagedTarget);
    await fs.promises.symlink(linkTarget, destination);
    return;
  }
  if (stat.isDirectory()) {
    await fs.promises.mkdir(destination, { recursive: true });
    return;
  }
  if (!stat.isFile()) {
    throw new Error(
      `the runtime dependency trace found an unsupported filesystem entry: ${source}`,
    );
  }
  await fs.promises.copyFile(source, destination);
}

/** Stages the explicit entry's runtime file graph beside the copied build dir.
 * `nodeFileTrace` follows import/require/package metadata; it does not rewrite
 * the app. Files already supplied by `dir` remain the author's verbatim copy. */
async function stageRuntimeDependencies(options: {
  readonly entryPath: string;
  readonly dirPath: string;
  readonly moduleDir: string;
  readonly cwd: string;
  readonly bundleDir: string;
}): Promise<void> {
  const resolvedCwd = path.resolve(options.cwd);
  const traceBase =
    isInside(resolvedCwd, options.moduleDir) && isInside(resolvedCwd, options.dirPath)
      ? resolvedCwd
      : commonAncestor(options.moduleDir, options.dirPath);
  const traced = await nodeFileTrace([options.entryPath], {
    base: traceBase,
    processCwd: traceBase,
  });

  for (const relative of [...traced.fileList].sort()) {
    const source = path.resolve(traceBase, relative);
    if (!isInside(traceBase, source)) {
      throw new Error(`the runtime dependency trace escaped its staging root: ${relative}`);
    }
    if (isInside(options.dirPath, source)) continue;
    const destination = path.join(options.bundleDir, ...relative.split('/'));
    if (fs.existsSync(destination)) continue;
    await copyTracedEntry(source, destination, traceBase, options.bundleDir, options.dirPath);
  }
}

async function assertBundleSymlinksStayInside(bundleDir: string): Promise<void> {
  const realRoot = await fs.promises.realpath(bundleDir);
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        let realTarget: string;
        try {
          realTarget = await fs.promises.realpath(full);
        } catch {
          throw new Error(`the assembled bundle contains a dangling symlink: ${full}`);
        }
        if (!isInside(realRoot, realTarget)) {
          throw new Error(
            `the assembled bundle contains a symlink whose target escapes the bundle: ${full} -> ${await fs.promises.readlink(full)}`,
          );
        }
      } else if (entry.isDirectory()) {
        await walk(full);
      }
    }
  };
  await walk(bundleDir);
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

  const bundleDir = path.join(workDir, 'bundle');
  await runnable.copyInto(bundleDir);
  if (buildDescriptor.dir !== undefined) {
    await stageRuntimeDependencies({
      entryPath: path.join(runnable.source, ...runnable.entry.split('/')),
      dirPath: runnable.source,
      moduleDir,
      cwd: input.cwd,
      bundleDir,
    });
  }
  await assertBundleSymlinksStayInside(bundleDir);

  return {
    dir: workDir,
    entry: path.posix.join('bundle', runnable.entry),
    // Single-file form: watch the entry file (== source). Directory form:
    // watch the whole dir (== source too) — a rebuild may touch only a
    // sibling of entry (ADR-0041).
    watch: [runnable.source],
  };
}

/** The node build extension descriptor — `prisma-composer.config.ts` lists it under `extensions`. */
export const nodeBuild = (): ExtensionDescriptor => ({
  id: '@prisma/composer/node',
  nodes: {
    node: { kind: 'build', assemble },
  },
});
