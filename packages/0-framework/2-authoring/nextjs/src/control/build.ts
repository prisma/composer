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
import { assertBundleSymlinksStayInside, copyTreeVerbatim, isWithin } from '@internal/bundle-paths';
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

/** What `.next/required-server-files.json` tells us: where Next put the app
 * inside the standalone tree, and the source root that tree mirrors. */
interface ServerFilesManifest {
  readonly path: string;
  readonly relativeAppDir: string | undefined;
  /** Absolute `config.outputFileTracingRoot`, or undefined when unrecorded. */
  readonly tracingRoot: string | undefined;
}

function readServerFilesManifest(appDir: string): ServerFilesManifest {
  const manifestPath = path.join(appDir, '.next', 'required-server-files.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `no ${path.join('.next', 'required-server-files.json')} under ${appDir} — run \`next build\` with output: "standalone" first.`,
    );
  }
  // JSON.parse is `any`; both fields we read are re-checked with `typeof`.
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const relativeAppDir: unknown = manifest?.relativeAppDir;
  const tracingRoot: unknown = manifest?.config?.outputFileTracingRoot;
  return {
    path: manifestPath,
    relativeAppDir: typeof relativeAppDir === 'string' ? relativeAppDir : undefined,
    tracingRoot: typeof tracingRoot === 'string' ? path.resolve(appDir, tracingRoot) : undefined,
  };
}

/**
 * The app's own subpath within `.next/standalone`, as an OS-relative path. Next
 * mirrors the app's location under `outputFileTracingRoot` (deep, when that's the
 * monorepo root); rather than walk the tree for `server.js`, we read where Next
 * put it from `.next/required-server-files.json` — `relativeAppDir` is exactly
 * that subpath. Older Next lacks the field; fall back to computing it from the
 * same manifest's `config.outputFileTracingRoot`.
 */
function appRelFrom(manifest: ServerFilesManifest, appDir: string): string {
  const posixRel =
    manifest.relativeAppDir ??
    (manifest.tracingRoot === undefined
      ? undefined
      : path.relative(manifest.tracingRoot, appDir).split(path.sep).join('/'));
  if (posixRel === undefined) {
    throw new Error(
      `${manifest.path} records neither relativeAppDir nor config.outputFileTracingRoot — cannot locate the standalone server`,
    );
  }
  const rel = posixRel.split('/').join(path.sep);
  if (path.isAbsolute(rel) || !isWithin(appDir, path.join(appDir, rel))) {
    throw new Error(
      `${manifest.path} records an app location that escapes its tracing root (${posixRel}) — refusing to stage outside the bundle`,
    );
  }
  return rel;
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

/** In-bundle link targets that the standalone tree does not contain — the
 * repairs staging has to make. */
async function missingLinkTargets(bundleDir: string): Promise<string[]> {
  const missing: string[] = [];
  for (const linkPath of await collectSymlinks(bundleDir)) {
    const rawTarget = await fs.promises.readlink(linkPath);
    if (path.isAbsolute(rawTarget)) continue;
    const target = path.resolve(path.dirname(linkPath), rawTarget);
    if (!isWithin(bundleDir, target) || (await lstatIfPresent(target)) !== undefined) continue;
    if (await hasSymlinkAncestor(bundleDir, target)) continue;
    missing.push(target);
  }
  return missing;
}

/**
 * pnpm can leave a traced hoist link in standalone while omitting the virtual-
 * store directory it targets. The same target still exists at the corresponding
 * path under outputFileTracingRoot. Stage only that exact, real in-root target;
 * unsafe or genuinely unavailable links remain for the packager to reject.
 */
async function stageMissingStandaloneLinkTargets(
  bundleDir: string,
  manifest: ServerFilesManifest,
): Promise<string[]> {
  const tracingRoot = manifest.tracingRoot;
  if (tracingRoot === undefined) {
    if ((await missingLinkTargets(bundleDir)).length === 0) return [];
    throw new Error(
      `${manifest.path} records no config.outputFileTracingRoot, but the standalone tree contains symlinks whose targets Next omitted — the source root those targets must be staged from is unknown. Rebuild with a Next version that records config.outputFileTracingRoot, or set outputFileTracingRoot in next.config.`,
    );
  }
  // required-server-files.json records the build machine's absolute tracing
  // root. A copied standalone build can be assembled elsewhere; if all of its
  // links are already complete, no access to the original root is needed.
  if ((await lstatIfPresent(tracingRoot)) === undefined) return [];
  const tracedRootReal = await fs.promises.realpath(tracingRoot);
  const stagedSources = new Set<string>();
  let staged = true;
  while (staged) {
    staged = false;
    for (const target of await missingLinkTargets(bundleDir)) {
      const standaloneRelative = path.relative(bundleDir, target);
      const source = path.resolve(tracingRoot, standaloneRelative);
      const sourceStat = await lstatIfPresent(source);
      if (sourceStat === undefined) continue;
      const sourceReal = await fs.promises.realpath(source);
      if (!isWithin(tracedRootReal, sourceReal)) continue;

      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await copyTreeVerbatim(source, target);
      stagedSources.add(source);
      staged = true;
    }
  }
  return [...stagedSources];
}

/** The built standalone server.js for a nextjs build — `appDir`'s standalone root plus the app subpath Next recorded. Single-sourced so `assemble()` (deploy) and the integration-test seam can't drift. */
export function standaloneServerPath(build: NextjsBuildAdapter): string {
  const appDir = path.resolve(path.dirname(fileURLToPath(build.module)), build.appDir);
  const manifest = readServerFilesManifest(appDir);
  return path.join(appDir, '.next', 'standalone', appRelFrom(manifest, appDir), 'server.js');
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
  const manifest = readServerFilesManifest(appDir);
  const appRel = appRelFrom(manifest, appDir);

  const workDir = path.join(input.cwd, '.prisma-composer', 'artifacts', input.address);
  await fs.promises.rm(workDir, { recursive: true, force: true });
  await fs.promises.mkdir(workDir, { recursive: true });
  const bundleDir = path.join(workDir, 'bundle');

  // Ship the standalone tree as `next build` produced it. Framework-emitted
  // links stay links; the packager validates that every target remains inside
  // the assembled bundle before emitting it into the archive.
  await copyTreeVerbatim(standaloneRoot, bundleDir);
  const stagedLinkTargets = await stageMissingStandaloneLinkTargets(bundleDir, manifest);

  // The documented copy: Next omits the client assets from standalone; place
  // them beside the app's server.js so it serves them (docs: `cp -r public
  // .next/standalone/ && cp -r .next/static .next/standalone/.next/`).
  const appOut = path.join(bundleDir, appRel);
  const staticSrc = path.join(appDir, '.next', 'static');
  if (fs.existsSync(staticSrc)) {
    await copyTreeVerbatim(staticSrc, path.join(appOut, '.next', 'static'));
  }
  const publicSrc = path.join(appDir, 'public');
  if (fs.existsSync(publicSrc)) {
    await copyTreeVerbatim(publicSrc, path.join(appOut, 'public'));
  }

  // Fail here, at the cause, rather than in the packager: a dangling or
  // escaping link left by the standalone tree or by a staged store payload is
  // reported against the assembled bundle it came from.
  await assertBundleSymlinksStayInside(bundleDir);

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
