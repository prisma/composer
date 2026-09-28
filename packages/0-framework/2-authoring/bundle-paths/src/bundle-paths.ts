/**
 * The path-containment predicate and bundle-link validation shared by every
 * assembly and packaging seam (node/nextjs adapters, the compute artifact
 * writer, the local extractor). This predicate is the enforcement point of
 * ADR-0047's boundary — a symlink may be preserved only while its target
 * stays inside the assembled bundle — so it exists exactly once.
 *
 * Windows cannot create `dir`/`file` symlinks without Developer Mode or an
 * elevated token (`EPERM`). Directory junctions need no such privilege, so
 * assemble uses them on win32; file links fall back to a copy of the target.
 */
import fs from 'node:fs';
import path from 'node:path';

export type BundleLinkStrategy = 'symlink' | 'junction' | 'symlink-with-copy-fallback';

/** How a platform materializes a bundle link without needing symlink privilege. */
export function bundleLinkStrategy(
  platform: NodeJS.Platform,
  type: 'dir' | 'file',
): BundleLinkStrategy {
  if (platform !== 'win32') return 'symlink';
  return type === 'dir' ? 'junction' : 'symlink-with-copy-fallback';
}

function isNotPermitted(error: unknown): boolean {
  return error instanceof Error && Reflect.get(error, 'code') === 'EPERM';
}

/**
 * Creates a link at `linkPath` whose stored target is `target`.
 * `resolvedTarget` is the absolute path of that target in the destination
 * tree — junctions require it, and the file-copy fallback reads from it.
 */
export async function createBundleLink(
  linkPath: string,
  target: string,
  type: 'dir' | 'file',
  options: {
    resolvedTarget: string;
    platform?: NodeJS.Platform;
  },
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const strategy = bundleLinkStrategy(platform, type);

  if (strategy === 'junction') {
    // Junctions ignore a relative target and resolve it against cwd; always
    // pass the absolute path of the in-bundle target.
    await fs.promises.symlink(options.resolvedTarget, linkPath, 'junction');
    return;
  }

  if (strategy === 'symlink') {
    await fs.promises.symlink(target, linkPath, type);
    return;
  }

  try {
    await fs.promises.symlink(target, linkPath, 'file');
  } catch (error) {
    if (!isNotPermitted(error)) throw error;
    await fs.promises.copyFile(options.resolvedTarget, linkPath);
  }
}

/** Restores directory-link metadata lost by `fs.cp` on Windows. */
export async function repairWindowsDirectorySymlinks(root: string): Promise<void> {
  if (process.platform !== 'win32') return;

  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await fs.promises.readlink(full);
        const resolvedTarget = path.resolve(path.dirname(full), target);
        try {
          if (!(await fs.promises.stat(resolvedTarget)).isDirectory()) continue;
        } catch {
          continue;
        }
        await fs.promises.unlink(full);
        await createBundleLink(full, target, 'dir', { resolvedTarget });
      } else if (entry.isDirectory()) {
        await visit(full);
      }
    }
  };

  await visit(root);
}

/** Copy without `fs.cp`'s symlink privilege requirement: real files first, then links. */
async function copyTreeVerbatimWalk(source: string, destination: string): Promise<void> {
  const links: Array<{ sourcePath: string; destinationPath: string }> = [];

  const copyNonLinks = async (sourceDir: string, destinationDir: string): Promise<void> => {
    await fs.promises.mkdir(destinationDir, { recursive: true });
    for (const entry of await fs.promises.readdir(sourceDir, { withFileTypes: true })) {
      const sourcePath = path.join(sourceDir, entry.name);
      const destinationPath = path.join(destinationDir, entry.name);
      if (entry.isSymbolicLink()) {
        links.push({ sourcePath, destinationPath });
      } else if (entry.isDirectory()) {
        await copyNonLinks(sourcePath, destinationPath);
      } else if (entry.isFile()) {
        await fs.promises.copyFile(sourcePath, destinationPath);
      }
    }
  };

  await copyNonLinks(source, destination);

  for (const { sourcePath, destinationPath } of links) {
    const target = await fs.promises.readlink(sourcePath);
    const resolvedSource = path.resolve(path.dirname(sourcePath), target);
    let type: 'dir' | 'file' = 'file';
    try {
      type = (await fs.promises.stat(resolvedSource)).isDirectory() ? 'dir' : 'file';
    } catch {
      // Dangling in the source — still emit the link; validation rejects escapes later.
    }
    await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
    await createBundleLink(destinationPath, target, type, {
      resolvedTarget: path.resolve(path.dirname(destinationPath), target),
    });
  }
}

export async function copyTreeVerbatim(source: string, destination: string): Promise<void> {
  try {
    await fs.promises.cp(source, destination, { recursive: true, verbatimSymlinks: true });
  } catch (error) {
    // win32 without Developer Mode: recreating symlinks during cp throws EPERM.
    if (!(process.platform === 'win32' && isNotPermitted(error))) throw error;
    await fs.promises.rm(destination, { recursive: true, force: true });
    await copyTreeVerbatimWalk(source, destination);
  }
  await repairWindowsDirectorySymlinks(destination);
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
