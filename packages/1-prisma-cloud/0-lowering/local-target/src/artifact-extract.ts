/**
 * Extracts the tar.gz `@internal/lowering`'s `packageComputeArtifact` writes
 * (local-dev spec § 4) — emulation-only code, so it lives here rather than
 * beside the writer (production source stays physically separated from
 * emulation). Reading tar is commodity even though the writer is a
 * deterministic subset we own (fixed mtimes, sorted entries): the maintained
 * `tar` package (dependency razor) does the parsing; this module keeps only
 * the pinned entry filtering (regular files plus safe relative symlinks,
 * reject devices/path escapes) and the directory-level temp-then-rename.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isWithin } from '@internal/bundle-paths';
import * as tar from 'tar';

function unsupportedEntryError(entryPath: string, type: string): Error {
  return new Error(
    `compute artifact entry "${entryPath}" has type "${type}" — only regular files and ` +
      'safe symlinks are supported; this artifact was not produced by packageComputeArtifact.',
  );
}

function pathEscapeError(entryPath: string): Error {
  return new Error(
    `compute artifact entry "${entryPath}" escapes the extraction directory — this artifact ` +
      'was not produced by packageComputeArtifact.',
  );
}

const REGULAR_FILE_TYPES = new Set(['File', 'OldFile', 'ContiguousFile']);
const SYMLINK_TYPE = 'SymbolicLink';

/**
 * Extracts `tarGzPath` (a `packageComputeArtifact` tar.gz) into `destDir`,
 * temp-then-rename at the directory level: entries are written into a
 * sibling temp directory first, then that directory is renamed onto
 * `destDir` — a concurrent unpack of the SAME hash races benignly (last
 * rename wins, both write identical bytes), and a reader of `destDir` never
 * sees a partial tree.
 */
export function extractComputeArtifact(tarGzPath: string, destDir: string): void {
  const parentDir = path.dirname(destDir);
  fs.mkdirSync(parentDir, { recursive: true });
  const tmpDir = path.join(parentDir, `.${path.basename(destDir)}.${crypto.randomUUID()}.tmp`);
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    tar.x({
      file: tarGzPath,
      cwd: tmpDir,
      sync: true,
      // preservePaths stays at its default (false): tar itself strips a
      // leading `/` and refuses a `..`-escaping path — the explicit check
      // below still names the entry in a pinned error rather than leaving
      // tar's own generic warning as the only signal.
      onentry: (entry) => {
        const resolved = path.resolve(tmpDir, entry.path);
        if (!isWithin(tmpDir, resolved)) {
          throw pathEscapeError(entry.path);
        }
        if (REGULAR_FILE_TYPES.has(entry.type)) return;
        if (entry.type !== SYMLINK_TYPE) {
          throw unsupportedEntryError(entry.path, entry.type);
        }
        if (entry.linkpath === undefined) {
          throw unsupportedEntryError(entry.path, `${entry.type} without a target`);
        }
        const linkTarget = path.resolve(path.dirname(resolved), entry.linkpath);
        if (!isWithin(tmpDir, linkTarget)) {
          throw pathEscapeError(`${entry.path} -> ${entry.linkpath}`);
        }
      },
    });
    fs.rmSync(destDir, { recursive: true, force: true });
    fs.renameSync(tmpDir, destDir);
  } catch (error) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw error;
  }
}
