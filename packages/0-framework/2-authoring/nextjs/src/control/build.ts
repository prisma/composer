/**
 * The extension's control entry (ADR-0017): `nextjsBuild()` returns the build
 * descriptor `prisma-composer.config.ts` lists. Deploy-only (ADR-0005): the user
 * runs `next build` (`output: "standalone"`); `assemble` then performs the
 * *documented* Next standalone deploy — it ships the standalone tree and copies
 * in the client assets Next deliberately omits (`.next/static`, `public/`) — and
 * adds the framework's boot wrapper. This is the canonical `cp` step from the
 * Next docs, run at deploy so no app needs a build-script for it.
 *
 * It does not guess: the app's location inside the standalone tree (deep, when
 * `outputFileTracingRoot` is the monorepo root) is *read from Next's own build
 * manifest* (`.next/required-server-files.json`'s `relativeAppDir`), never walked
 * for or computed from a hardcoded depth. It does not launder: node_modules is
 * shipped exactly as `next build` produced it. The packager preserves a link
 * only after resolving its target inside the assembled bundle, and rejects
 * escaping links. When Next records an in-root package link but omits its target
 * from standalone (seen with pnpm's virtual store), assembly stages that exact
 * target from `outputFileTracingRoot` so the artifact remains self-contained.
 *
 * Artifact layout: `<workDir>/main.mjs` (our wrapper) + `<workDir>/bundle/`
 * (the standalone tree, with static/public copied in). The packager adds
 * `bootstrap.js` + the manifest at the root; bootstrap imports main.mjs, whose
 * run() dynamically imports `./bundle/<relativeAppDir>/server.js`.
 *
 * Paths are file-relative (ADR-0004): `appDir` resolves against
 * `dirname(build.module)`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BuildAdapter } from '@internal/core';
import type { ExtensionDescriptor } from '@internal/core/config';
import type { AssembleInput, Bundle } from '@internal/core/deploy';
import { build } from 'esbuild';
import type { NextjsBuildAdapter } from '../nextjs.ts';

export type { AssembleInput, Bundle } from '@internal/core/deploy';

/** Narrows the shared BuildAdapter to this extension's own descriptor — the value-level mirror of the registry routing on (extension, type). */
function isNextjsBuild(descriptor: BuildAdapter): descriptor is NextjsBuildAdapter {
  return (
    descriptor.type === 'nextjs' && 'appDir' in descriptor && typeof descriptor.appDir === 'string'
  );
}

/**
 * The app's own subpath within `.next/standalone`, as an OS-relative path. Next
 * mirrors the app's location under `outputFileTracingRoot` (deep, when that's the
 * monorepo root); rather than walk the tree for `server.js`, we read where Next
 * put it from `.next/required-server-files.json` — `relativeAppDir` is exactly
 * that subpath. Older Next lacks the field; fall back to computing it from the
 * same manifest's `config.outputFileTracingRoot`.
 */
function nextAppRel(appDir: string): string {
  const manifestPath = path.join(appDir, '.next', 'required-server-files.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `no ${path.join('.next', 'required-server-files.json')} under ${appDir} — run \`next build\` with output: "standalone" first.`,
    );
  }
  // JSON.parse is `any`; both fields we read are re-checked with `typeof` below.
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const relativeAppDir: unknown = manifest?.relativeAppDir;
  const tracingRoot: unknown = manifest?.config?.outputFileTracingRoot;
  const posixRel =
    typeof relativeAppDir === 'string'
      ? relativeAppDir
      : typeof tracingRoot === 'string'
        ? path.relative(tracingRoot, appDir).split(path.sep).join('/')
        : undefined;
  if (posixRel === undefined) {
    throw new Error(
      `${manifestPath} records neither relativeAppDir nor config.outputFileTracingRoot — cannot locate the standalone server`,
    );
  }
  return posixRel.split('/').join(path.sep);
}

/** Next's trace root is the source tree mirrored by `.next/standalone`. */
function nextTracingRoot(appDir: string): string {
  const manifestPath = path.join(appDir, '.next', 'required-server-files.json');
  // The manifest was existence-checked and parsed by nextAppRel() first.
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const tracingRoot: unknown = manifest?.config?.outputFileTracingRoot;
  return typeof tracingRoot === 'string' ? path.resolve(appDir, tracingRoot) : appDir;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

async function lstatIfPresent(candidate: string): Promise<fs.Stats | undefined> {
  try {
    return await fs.promises.lstat(candidate);
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, 'code') === 'ENOENT') return undefined;
    throw error;
  }
}

/** Do not write through an existing link while repairing a missing target. */
async function hasSymlinkAncestor(root: string, candidate: string): Promise<boolean> {
  const relative = path.relative(root, path.dirname(candidate));
  let cursor = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const stat = await lstatIfPresent(cursor);
    if (stat === undefined) return false;
    if (stat.isSymbolicLink()) return true;
  }
  return false;
}

async function collectSymlinks(root: string): Promise<string[]> {
  const links: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) links.push(entryPath);
      else if (entry.isDirectory()) await visit(entryPath);
    }
  }
  await visit(root);
  return links;
}

/**
 * pnpm can leave a traced hoist link in standalone while omitting the virtual-
 * store directory it targets. The same target still exists at the corresponding
 * path under outputFileTracingRoot. Stage only that exact, real in-root target;
 * unsafe or genuinely unavailable links remain for the packager to reject.
 */
async function stageMissingStandaloneLinkTargets(
  bundleDir: string,
  tracingRoot: string,
): Promise<string[]> {
  const tracedRootReal = await fs.promises.realpath(tracingRoot);
  const stagedSources = new Set<string>();
  let staged = true;
  while (staged) {
    staged = false;
    for (const linkPath of await collectSymlinks(bundleDir)) {
      const rawTarget = await fs.promises.readlink(linkPath);
      if (path.isAbsolute(rawTarget)) continue;
      const target = path.resolve(path.dirname(linkPath), rawTarget);
      if (!isWithin(bundleDir, target) || (await lstatIfPresent(target)) !== undefined) continue;
      if (await hasSymlinkAncestor(bundleDir, target)) continue;

      const standaloneRelative = path.relative(bundleDir, target);
      const source = path.resolve(tracingRoot, standaloneRelative);
      const sourceStat = await lstatIfPresent(source);
      if (sourceStat === undefined) continue;
      const sourceReal = await fs.promises.realpath(source);
      if (!isWithin(tracedRootReal, sourceReal)) continue;

      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.cp(source, target, { recursive: true, verbatimSymlinks: true });
      stagedSources.add(source);
      staged = true;
    }
  }
  return [...stagedSources];
}

/** The built standalone server.js for a nextjs build — `appDir`'s standalone root plus the app subpath Next recorded. Single-sourced so `assemble()` (deploy) and the integration-test seam can't drift. */
export function standaloneServerPath(build: NextjsBuildAdapter): string {
  const appDir = path.resolve(path.dirname(fileURLToPath(build.module)), build.appDir);
  return path.join(appDir, '.next', 'standalone', nextAppRel(appDir), 'server.js');
}

export async function assemble(input: AssembleInput): Promise<Bundle> {
  if (!isNextjsBuild(input.build)) {
    throw new Error(
      `@prisma/composer/nextjs/control: expected a "nextjs" build adapter (with appDir), got "${input.build.type}".`,
    );
  }
  const buildDescriptor = input.build;

  const appDir = path.resolve(
    path.dirname(fileURLToPath(buildDescriptor.module)),
    buildDescriptor.appDir,
  );
  const standaloneRoot = path.join(appDir, '.next', 'standalone');
  if (!fs.existsSync(standaloneRoot)) {
    throw new Error(
      `no ${path.join('.next', 'standalone')} under ${appDir} — run \`next build\` with output: "standalone" first.`,
    );
  }
  // The app's (possibly deep) location within the standalone tree — read from
  // Next's own build manifest, not searched for.
  const appRel = nextAppRel(appDir);
  const tracingRoot = nextTracingRoot(appDir);

  const workDir = path.join(input.cwd, '.prisma-composer', 'artifacts', input.address);
  await fs.promises.rm(workDir, { recursive: true, force: true });
  await fs.promises.mkdir(workDir, { recursive: true });
  const bundleDir = path.join(workDir, 'bundle');

  // Ship the standalone tree as `next build` produced it. Framework-emitted
  // links stay links; the packager validates that every target remains inside
  // the assembled bundle before emitting it into the archive.
  await fs.promises.cp(standaloneRoot, bundleDir, {
    recursive: true,
    verbatimSymlinks: true,
  });
  const stagedLinkTargets = await stageMissingStandaloneLinkTargets(bundleDir, tracingRoot);

  // The documented copy: Next omits the client assets from standalone; place
  // them beside the app's server.js so it serves them (docs: `cp -r public
  // .next/standalone/ && cp -r .next/static .next/standalone/.next/`).
  const appOut = path.join(bundleDir, appRel);
  const staticSrc = path.join(appDir, '.next', 'static');
  if (fs.existsSync(staticSrc)) {
    await fs.promises.cp(staticSrc, path.join(appOut, '.next', 'static'), {
      recursive: true,
      verbatimSymlinks: true,
    });
  }
  const publicSrc = path.join(appDir, 'public');
  if (fs.existsSync(publicSrc)) {
    await fs.promises.cp(publicSrc, path.join(appOut, 'public'), {
      recursive: true,
      verbatimSymlinks: true,
    });
  }

  // Our wrapper, bundled to main.mjs at the working-dir root (unambiguously
  // ESM). run()'s `import("./bundle/<server>")` resolves from here.
  const serviceModule = fileURLToPath(buildDescriptor.module);
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

  return {
    dir: workDir,
    entry: path.posix.join('bundle', appRel.split(path.sep).join('/'), 'server.js'),
    watch: [standaloneRoot, ...stagedLinkTargets],
  };
}

/** The nextjs build extension descriptor — `prisma-composer.config.ts` lists it under `extensions`. */
export const nextjsBuild = (): ExtensionDescriptor => ({
  id: '@prisma/composer/nextjs',
  nodes: {
    nextjs: { kind: 'build', assemble },
  },
});
