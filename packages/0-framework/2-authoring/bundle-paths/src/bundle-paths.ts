/**
 * The path-containment predicate and bundle-link validation shared by every
 * assembly and packaging seam (node/nextjs adapters, the compute artifact
 * writer, the local extractor). This predicate is the enforcement point of
 * ADR-0047's boundary — a symlink may be preserved only while its target
 * stays inside the assembled bundle — so it exists exactly once.
 */
import fs from 'node:fs';
import path from 'node:path';

export type BundleLinkKind = 'dir' | 'file';

export interface BundleLinkPlan {
  readonly target: string;
  readonly type: 'junction' | 'dir' | 'file';
}

/** Windows refuses symlinks (EPERM) without SeCreateSymbolicLinkPrivilege; a
 * junction needs none, so every Windows user gets one. */
function directoryLinksAreJunctions(platform: NodeJS.Platform): boolean {
  return platform === 'win32';
}

/** Windows: directory links are junctions (no privilege needed, absolute
 * target); file links stay symlinks because a copy would archive as a regular
 * file (ADR-0047). `platform` is a test seam. */
export function planBundleLink(
  target: string,
  linkPath: string,
  kind: BundleLinkKind,
  platform: NodeJS.Platform = process.platform,
): BundleLinkPlan {
  if (directoryLinksAreJunctions(platform) && kind === 'dir') {
    return { target: path.resolve(path.dirname(linkPath), target), type: 'junction' };
  }
  return { target, type: kind };
}

/** An absent target cannot be typed; 'dir' is the kind every user can create,
 * and `repairWindowsDirectorySymlinks` re-types it once the target is staged. */
export async function bundleLinkKind(resolvedTarget: string): Promise<BundleLinkKind> {
  try {
    return (await fs.promises.stat(resolvedTarget)).isDirectory() ? 'dir' : 'file';
  } catch {
    return 'dir';
  }
}

export async function createBundleLink(
  target: string,
  linkPath: string,
  kind: BundleLinkKind,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const plan = planBundleLink(target, linkPath, kind, platform);
  try {
    await fs.promises.symlink(plan.target, linkPath, plan.type);
  } catch (error) {
    const denied = error instanceof Error && Reflect.get(error, 'code') === 'EPERM';
    if (denied && directoryLinksAreJunctions(platform) && plan.type === 'file') {
      throw new Error(
        `cannot create the file symlink ${linkPath} -> ${target}: Windows only lets a user with the ` +
          'symbolic-link privilege create one. Enable Developer Mode (or deploy from an elevated shell), ' +
          'or build so the output links directories rather than files — directory links need no privilege.',
        { cause: error },
      );
    }
    throw error;
  }
}

async function lstatIfPresent(candidate: string): Promise<fs.Stats | undefined> {
  try {
    return await fs.promises.lstat(candidate);
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, 'code') === 'ENOENT') return undefined;
    throw error;
  }
}

/** `fs.cp` recreates links as privileged symlinks, so Windows copies through
 * `createBundleLink`. Junction targets read back absolute, so in-tree targets
 * are re-anchored into the destination. */
async function copyTreeThroughBundleLinks(
  source: string,
  destination: string,
  platform: NodeJS.Platform,
): Promise<void> {
  const copyLink = async (
    from: string,
    to: string,
    target: string,
    written: string,
  ): Promise<void> => {
    const kind = await bundleLinkKind(path.resolve(path.dirname(from), target));
    const existing = await lstatIfPresent(to);
    if (existing !== undefined && !existing.isDirectory()) await fs.promises.unlink(to);
    await createBundleLink(written, to, kind, platform);
  };

  const sourceStat = await fs.promises.lstat(source);
  if (!sourceStat.isDirectory()) {
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    if (sourceStat.isSymbolicLink()) {
      const target = await fs.promises.readlink(source);
      await copyLink(source, destination, target, target);
    } else if (sourceStat.isFile()) {
      await fs.promises.copyFile(source, destination);
    } else {
      throw new Error(`cannot copy an unsupported filesystem entry: ${source}`);
    }
    return;
  }

  // A junction may record the tree's real path rather than the one given.
  const sourceRoots = [...new Set([path.resolve(source), await fs.promises.realpath(source)])];
  const reanchored = (target: string, to: string): string => {
    if (!path.isAbsolute(target)) return target;
    const root = sourceRoots.find((candidate) => isWithin(candidate, target));
    if (root === undefined) return target;
    return path.relative(path.dirname(to), path.join(destination, path.relative(root, target)));
  };

  const copyDirectory = async (from: string, to: string): Promise<void> => {
    await fs.promises.mkdir(to, { recursive: true });
    for (const entry of await fs.promises.readdir(from, { withFileTypes: true })) {
      const entryFrom = path.join(from, entry.name);
      const entryTo = path.join(to, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await fs.promises.readlink(entryFrom);
        await copyLink(entryFrom, entryTo, target, reanchored(target, entryTo));
      } else if (entry.isDirectory()) {
        await copyDirectory(entryFrom, entryTo);
      } else if (entry.isFile()) {
        await fs.promises.copyFile(entryFrom, entryTo);
      } else {
        throw new Error(`cannot copy an unsupported filesystem entry: ${entryFrom}`);
      }
    }
  };
  await copyDirectory(source, destination);
}

/** Re-types links created while their target was absent (see `bundleLinkKind`). */
export async function repairWindowsDirectorySymlinks(
  root: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (!directoryLinksAreJunctions(platform)) return;

  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await fs.promises.readlink(full);
        const resolvedTarget = path.resolve(path.dirname(full), target);
        let kind: BundleLinkKind;
        try {
          kind = (await fs.promises.stat(resolvedTarget)).isDirectory() ? 'dir' : 'file';
        } catch {
          continue;
        }
        await fs.promises.unlink(full);
        await createBundleLink(target, full, kind, platform);
      } else if (entry.isDirectory()) {
        await visit(full);
      }
    }
  };

  await visit(root);
}

export async function copyTreeVerbatim(
  source: string,
  destination: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (directoryLinksAreJunctions(platform)) {
    await copyTreeThroughBundleLinks(source, destination, platform);
    return;
  }
  await fs.promises.cp(source, destination, { recursive: true, verbatimSymlinks: true });
}

/** Lexical containment: `candidate` is `root` itself or below it. Both paths
 * must already be absolute or share a resolution base; no filesystem access. */
export function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

/** Walks the assembled bundle and rejects a dangling symlink or one whose
 * resolved target escapes the bundle root. Symlinked directories are not
 * descended: their targets are validated, and their contents belong to the
 * target's own location. */
export async function assertBundleSymlinksStayInside(bundleDir: string): Promise<void> {
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
        if (!isWithin(realRoot, realTarget)) {
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
