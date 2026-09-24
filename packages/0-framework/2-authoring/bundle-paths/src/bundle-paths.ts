/**
 * The path-containment predicate and bundle-link validation shared by every
 * assembly and packaging seam (node/framework adapters, the compute artifact
 * writer, the local extractor). This predicate is the enforcement point of
 * ADR-0047's boundary — a symlink may be preserved only while its target
 * stays inside the assembled bundle — so it exists exactly once. It also
 * holds the one reading of a wrapper build's inputs both adapters watch.
 */
import fs from 'node:fs';
import path from 'node:path';

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
        await fs.promises.symlink(target, full, 'dir');
      } else if (entry.isDirectory()) {
        await visit(full);
      }
    }
  };

  await visit(root);
}

export async function copyTreeVerbatim(source: string, destination: string): Promise<void> {
  await fs.promises.cp(source, destination, { recursive: true, verbatimSymlinks: true });
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

/**
 * The source files a wrapper build bundled — esbuild's metafile `inputs`,
 * recorded relative to its working directory — as absolute `Bundle.watch`
 * paths. The wrapper bundles the service module and everything it imports,
 * including contracts from other modules (workspace packages resolve to their
 * real paths), so an edit there must reassemble this service. Installed
 * packages under `node_modules` are left out: they change only on install.
 */
export function bundledSourcePaths(
  inputs: Readonly<Record<string, unknown>>,
  workingDir: string,
): string[] {
  return Object.keys(inputs)
    .map((input) => path.resolve(workingDir, input))
    .filter((file) => !file.split(path.sep).includes('node_modules') && fs.existsSync(file));
}
