/**
 * The path-containment predicate and bundle-link validation shared by every
 * assembly and packaging seam (node/nextjs adapters, the compute artifact
 * writer, the local extractor). This predicate is the enforcement point of
 * ADR-0047's boundary — a symlink may be preserved only while its target
 * stays inside the assembled bundle — so it exists exactly once.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Repairs the one piece of link metadata `fs.cp` loses on Windows: whether a
 * relative symlink targets a directory. Without the explicit type, Node
 * recreates it as a file link and the copied tree contains a dangling link. */
async function repairWindowsDirectorySymlinks(source: string, destination: string): Promise<void> {
  const sourceStat = await fs.promises.lstat(source);
  if (sourceStat.isSymbolicLink()) {
    try {
      if (!(await fs.promises.stat(source)).isDirectory()) return;
    } catch {
      // Keep a dangling source link dangling so bundle validation reports it.
      return;
    }
    const target = await fs.promises.readlink(source);
    await fs.promises.rm(destination, { recursive: true, force: true });
    await fs.promises.symlink(target, destination, 'dir');
    return;
  }
  if (!sourceStat.isDirectory()) return;
  await Promise.all(
    (await fs.promises.readdir(source)).map((entry) =>
      repairWindowsDirectorySymlinks(path.join(source, entry), path.join(destination, entry)),
    ),
  );
}

/** Copies a file tree without dereferencing links, retaining the native
 * implementation's performance and metadata behavior. */
export async function copyTreeVerbatim(source: string, destination: string): Promise<void> {
  await fs.promises.cp(source, destination, { recursive: true, verbatimSymlinks: true });
  if (process.platform === 'win32') {
    await repairWindowsDirectorySymlinks(source, destination);
  }
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
