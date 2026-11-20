#!/usr/bin/env bun
/**
 * Fails when a package this workspace patches with `pnpm patch` is in the run-time install of a published package, by any path.
 * A patch applies only to this workspace's install; a user's install gets the unpatched package.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const usage = 'Usage: bun scripts/check-patched-dependencies.ts, run from the repository root';

type Resolved = Readonly<Record<string, { readonly version: string }>>;

/** The parts of `pnpm-lock.yaml` the check reads. */
export interface Lockfile {
  readonly patchedDependencies?: Readonly<Record<string, unknown>>;
  readonly importers: Readonly<
    Record<string, { readonly dependencies?: Resolved; readonly optionalDependencies?: Resolved }>
  >;
  readonly snapshots?: Readonly<
    Record<
      string,
      {
        readonly dependencies?: Readonly<Record<string, string>>;
        readonly optionalDependencies?: Readonly<Record<string, string>>;
      } | null
    >
  >;
}

export interface PatchedRuntimeDependency {
  readonly patched: string;
  readonly publishedPackage: string;
  readonly via: readonly string[];
}

/** `@scope/name@1.2.3` → `@scope/name`. */
export function packageNameOf(patchKey: string): string {
  const at = patchKey.lastIndexOf('@');
  return at > 0 ? patchKey.slice(0, at) : patchKey;
}

/** Every package name a patch is declared for: in the root manifest, in the workspace file, or recorded in the lockfile. */
export function patchedNames(declared: {
  readonly rootManifest?: { readonly pnpm?: { readonly patchedDependencies?: object } };
  readonly workspaceFile?: { readonly patchedDependencies?: object } | null;
  readonly lockfile: Lockfile;
}): Set<string> {
  return new Set(
    [
      ...Object.keys(declared.rootManifest?.pnpm?.patchedDependencies ?? {}),
      ...Object.keys(declared.workspaceFile?.patchedDependencies ?? {}),
      ...Object.keys(declared.lockfile.patchedDependencies ?? {}),
    ].map(packageNameOf),
  );
}

/**
 * Walks each published importer's `dependencies` and `optionalDependencies` through the lockfile: the workspace
 * packages it installs (`link:`) and every third-party package below them. A workspace package that is only a
 * devDependency is bundled, and its imports are inlined unless the published package lists them, so only listed
 * dependencies reach a user's install.
 */
export function patchedRuntimeDependencies(
  patched: ReadonlySet<string>,
  published: ReadonlyMap<string, string>,
  lockfile: Lockfile,
): PatchedRuntimeDependency[] {
  const found: PatchedRuntimeDependency[] = [];
  for (const [importerPath, publishedPackage] of published) {
    const seen = new Set<string>();
    const reported = new Set<string>();
    const walkImporter = (importer: string, via: readonly string[]): void => {
      if (seen.has(`importer:${importer}`)) return;
      seen.add(`importer:${importer}`);
      const entry = lockfile.importers[importer];
      for (const [dependency, { version }] of Object.entries({
        ...entry?.dependencies,
        ...entry?.optionalDependencies,
      })) {
        visit(dependency, version, importer, via);
      }
    };
    const visit = (name: string, version: string, from: string, via: readonly string[]): void => {
      if (patched.has(name) && !reported.has(name)) {
        reported.add(name);
        found.push({ patched: name, publishedPackage, via });
      }
      if (version.startsWith('link:')) {
        const linked = path.posix.normalize(path.posix.join(from, version.slice('link:'.length)));
        walkImporter(linked, [...via, name]);
        return;
      }
      const key = `${name}@${version}`;
      if (seen.has(key)) return;
      seen.add(key);
      const snapshot = lockfile.snapshots?.[key];
      for (const [dependency, dependencyVersion] of Object.entries({
        ...snapshot?.dependencies,
        ...snapshot?.optionalDependencies,
      })) {
        visit(dependency, dependencyVersion, from, [...via, name]);
      }
    };
    walkImporter(importerPath, []);
  }
  return found;
}

export function failureMessage(found: readonly PatchedRuntimeDependency[]): string {
  const lines = found.map(
    ({ patched, publishedPackage, via }) =>
      `- ${publishedPackage} depends on ${patched}${via.length > 0 ? ` (through ${via.join(' → ')})` : ''}`,
  );
  return (
    'A published package depends at run time on a package this workspace patches with `pnpm patch`:\n' +
    `${lines.join('\n')}\n` +
    'A patch applies only to this workspace. A user who installs the published package gets the unpatched dependency, ' +
    'so the release would behave differently from what was tested. Release the change upstream, raise the pin to that ' +
    'release and remove the patch before publishing.'
  );
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isLockfile = (value: unknown): value is Lockfile =>
  isRecord(value) && isRecord(value['importers']);

function readText(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    console.error(`Cannot read ${file}. ${usage}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  const root = process.cwd();
  const lockfile = Bun.YAML.parse(readText(path.join(root, 'pnpm-lock.yaml')));
  if (!isLockfile(lockfile)) {
    console.error(`pnpm-lock.yaml has no importers. ${usage}`);
    process.exit(1);
  }
  const workspaceFile = Bun.YAML.parse(readText(path.join(root, 'pnpm-workspace.yaml')));
  const patched = patchedNames({
    rootManifest: JSON.parse(readText(path.join(root, 'package.json'))),
    workspaceFile: isRecord(workspaceFile) ? workspaceFile : null,
    lockfile,
  });
  const published = new Map<string, string>();
  for (const importer of Object.keys(lockfile.importers)) {
    if (!importer.startsWith('packages/9-public/')) continue;
    published.set(importer, JSON.parse(readText(path.join(root, importer, 'package.json'))).name);
  }
  const found = patchedRuntimeDependencies(patched, published, lockfile);
  if (found.length > 0) {
    console.error(failureMessage(found));
    process.exit(1);
  }
  console.log(`No published package depends on a patched package (${published.size} checked).`);
}
