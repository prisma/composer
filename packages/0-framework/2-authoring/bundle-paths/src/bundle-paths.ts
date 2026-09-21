/**
 * The path-containment predicate and bundle-link validation shared by every
 * assembly and packaging seam (node/nextjs adapters, the compute artifact
 * writer, the local extractor). This predicate is the enforcement point of
 * ADR-0047's boundary — a symlink may be preserved only while its target
 * stays inside the assembled bundle — so it exists exactly once.
 *
 * It also owns how a bundle link is written. What a link is on disk differs by
 * platform (`planBundleLink`); what it means — and what the packager archives —
 * does not. Every seam that creates or copies a link goes through here, so no
 * caller branches on the platform.
 */
import fs from 'node:fs';
import path from 'node:path';

/** What a bundle link points at. Windows types its links; POSIX ignores this. */
export type BundleLinkKind = 'dir' | 'file';

/** The exact `fs.symlink(target, linkPath, type)` arguments for one bundle link. */
export interface BundleLinkPlan {
  readonly target: string;
  readonly type: 'junction' | 'dir' | 'file';
}

/**
 * The one platform fact every link decision below derives from. Windows only
 * lets a process holding SeCreateSymbolicLinkPrivilege (Developer Mode, or an
 * elevated shell) create a symbolic link; a default user gets EPERM. A
 * junction needs no privilege, so on Windows a directory link is always a
 * junction — for every user, privileged or not, so the same inputs assemble the
 * same bundle on every Windows machine.
 */
function directoryLinksAreJunctions(platform: NodeJS.Platform): boolean {
  return platform === 'win32';
}

/**
 * Decides how a bundle link is created — the only place that decision is made.
 *
 * - POSIX: the link is written as given (links are untyped there).
 * - Windows, directory: a junction. A junction stores an absolute target, so a
 *   relative `target` is resolved against the link's own directory here rather
 *   than left to the runtime. Absoluteness is only the on-disk representation:
 *   the packager archives an in-bundle absolute target as the same relative
 *   link entry POSIX produces.
 * - Windows, file: a file symbolic link. A junction cannot point at a file, and
 *   a copy or a hard link would archive as a regular file — a dereferenced link,
 *   which ADR-0047 forbids — so a file link stays a real link and needs the
 *   privilege.
 *
 * `platform` is a test seam; production callers leave it at the default.
 */
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

/** The kind of link `resolvedTarget` needs. A target that is not there cannot
 * be typed; it is treated as a directory because that link can be created
 * without privilege on every platform. A link left dangling is rejected by
 * `assertBundleSymlinksStayInside`, and one whose target is staged afterwards is
 * re-typed by `repairWindowsDirectorySymlinks`. */
export async function bundleLinkKind(resolvedTarget: string): Promise<BundleLinkKind> {
  try {
    return (await fs.promises.stat(resolvedTarget)).isDirectory() ? 'dir' : 'file';
  } catch {
    return 'dir';
  }
}

/** Creates the link at `linkPath` pointing at `target` (relative to the link's
 * directory, or absolute). Every link an assembly seam writes goes through
 * here; see `planBundleLink` for what is written on each platform. */
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

/**
 * The Windows tree copy. `fs.cp` cannot be used there: it re-creates every link
 * with an untyped `fs.symlink`, which Node resolves to a 'dir' or 'file'
 * symbolic link — EPERM without the privilege — and mistypes a link whose
 * target has not been copied yet. This copy is otherwise the same verbatim
 * copy, with links routed through `createBundleLink`.
 *
 * One thing cannot be verbatim: `readlink` reports a junction's target as an
 * absolute path, so copying that string would leave the copy pointing back into
 * the source tree. An absolute target inside the copied tree is therefore
 * re-anchored to the same location in the destination. Absolute targets outside
 * the tree are kept as they are, for the bundle validator to judge.
 */
async function copyTreeThroughBundleLinks(
  source: string,
  destination: string,
  platform: NodeJS.Platform,
): Promise<void> {
  /** `target` is what `from` records; `written` is what the copy at `to` records. */
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

  // A junction records whichever spelling of the path its creator used, so an
  // in-tree target is recognised under the tree's given and real paths alike.
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

/**
 * Re-creates the links under `root` whose kind could not be known when they
 * were written: a link created while its target was missing is a junction, and
 * staging the target afterwards may reveal a file. Every link whose target now
 * exists is re-created through `createBundleLink` with that target's kind; one
 * that still dangles is left for `assertBundleSymlinksStayInside` to reject.
 * POSIX links are untyped, so there is nothing to repair there.
 */
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

/** Copies `source` to `destination` with every link kept a link — never
 * followed. POSIX copies link targets verbatim; see
 * `copyTreeThroughBundleLinks` for what Windows needs instead. */
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
