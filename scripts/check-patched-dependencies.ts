#!/usr/bin/env bun
/**
 * Fails when a published package depends at run time on a package this workspace patches with `pnpm patch`.
 * A patch applies only to this workspace's install; a user's install gets the unpatched package.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';

const usage = 'Usage: bun scripts/check-patched-dependencies.ts, run from the repository root';

export interface Manifest {
  readonly name: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
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

const runtimeDependencies = (manifest: Manifest): string[] =>
  Object.keys({
    ...manifest.dependencies,
    ...manifest.peerDependencies,
    ...manifest.optionalDependencies,
  });

/**
 * The workspace packages a user's install of `manifest` also installs. A workspace package a published package
 * bundles from its devDependencies is not followed: its external dependencies must be the published package's own.
 */
const workspaceDependencies = (manifest: Manifest, workspace: ReadonlyMap<string, Manifest>) =>
  runtimeDependencies(manifest).filter((name) => workspace.has(name));

export function patchedRuntimeDependencies(
  patchKeys: readonly string[],
  published: readonly string[],
  workspace: ReadonlyMap<string, Manifest>,
): PatchedRuntimeDependency[] {
  const patched = new Set(patchKeys.map(packageNameOf));
  const found: PatchedRuntimeDependency[] = [];
  for (const publishedPackage of published) {
    const seen = new Set<string>();
    const walk = (name: string, via: readonly string[]): void => {
      if (seen.has(name)) return;
      seen.add(name);
      const manifest = workspace.get(name);
      if (manifest === undefined) return;
      for (const dependency of runtimeDependencies(manifest)) {
        if (patched.has(dependency)) found.push({ patched: dependency, publishedPackage, via });
      }
      for (const dependency of workspaceDependencies(manifest, workspace)) {
        walk(dependency, [...via, dependency]);
      }
    };
    walk(publishedPackage, []);
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

function manifestsUnder(dir: string, into: Map<string, { manifest: Manifest; dir: string }>): void {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      manifestsUnder(full, into);
    } else if (entry === 'package.json') {
      const manifest: Manifest = JSON.parse(readFileSync(full, 'utf8'));
      if (typeof manifest.name === 'string') into.set(manifest.name, { manifest, dir });
    }
  }
}

if (import.meta.main) {
  const root = process.cwd();
  let rootManifest: { pnpm?: { patchedDependencies?: Record<string, string> } };
  try {
    rootManifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch {
    console.error(`No package.json in ${root}. ${usage}`);
    process.exit(1);
  }
  const packages = new Map<string, { manifest: Manifest; dir: string }>();
  manifestsUnder(path.join(root, 'packages'), packages);
  const published = [...packages.values()]
    .filter(({ dir }) => path.relative(root, dir).startsWith(path.join('packages', '9-public')))
    .map(({ manifest }) => manifest.name);
  const workspace = new Map([...packages].map(([name, { manifest }]) => [name, manifest]));
  const found = patchedRuntimeDependencies(
    Object.keys(rootManifest.pnpm?.patchedDependencies ?? {}),
    published,
    workspace,
  );
  if (found.length > 0) {
    console.error(failureMessage(found));
    process.exit(1);
  }
  console.log(`No published package depends on a patched package (${published.length} checked).`);
}
