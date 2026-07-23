/**
 * Reads the deterministic ustar tar.gz `artifact.ts`'s `packageComputeArtifact`
 * writes (local-dev spec § 4) — a minimal reader matching exactly what that
 * writer emits: regular files only, name+prefix path fields, fixed-size
 * headers, no links. Extraction is temp-then-rename at the DIRECTORY level, so
 * a concurrent reader of `destDir` never observes a partially-unpacked tree.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

const HEADER_SIZE = 512;
const REGULAR_FILE_TYPEFLAG = '0';

interface UstarEntry {
  readonly relPath: string;
  readonly content: Buffer;
}

function readField(header: Buffer, offset: number, length: number): string {
  const raw = header.subarray(offset, offset + length);
  const nul = raw.indexOf(0);
  return (nul === -1 ? raw : raw.subarray(0, nul)).toString('utf8');
}

function unsupportedTypeflagError(relPath: string, typeflag: string): Error {
  return new Error(
    `compute artifact entry "${relPath}" has typeflag "${typeflag}" — only regular files ` +
      '(typeflag "0") are supported; this artifact was not produced by packageComputeArtifact.',
  );
}

/** Parses every entry out of a raw (already gunzipped) ustar tar buffer. */
function readUstarEntries(tar: Buffer): readonly UstarEntry[] {
  const entries: UstarEntry[] = [];
  let offset = 0;
  while (offset + HEADER_SIZE <= tar.length) {
    const header = tar.subarray(offset, offset + HEADER_SIZE);
    if (header.every((b) => b === 0)) break; // end-of-archive block

    const name = readField(header, 0, 100);
    const sizeOctal = readField(header, 124, 12).trim();
    const typeflag = readField(header, 156, 1) || REGULAR_FILE_TYPEFLAG;
    const prefix = readField(header, 345, 155);
    offset += HEADER_SIZE;

    const size = Number.parseInt(sizeOctal, 8);
    const relPath = prefix.length > 0 ? `${prefix}/${name}` : name;
    if (typeflag !== REGULAR_FILE_TYPEFLAG) throw unsupportedTypeflagError(relPath, typeflag);

    const content = tar.subarray(offset, offset + size);
    entries.push({ relPath, content: Buffer.from(content) });
    offset += Math.ceil(size / HEADER_SIZE) * HEADER_SIZE;
  }
  return entries;
}

/**
 * Extracts `tarGzPath` (a `packageComputeArtifact` tar.gz) into `destDir`,
 * temp-then-rename at the directory level: entries are written into a sibling
 * temp directory first, then that directory is renamed onto `destDir` — a
 * concurrent unpack of the SAME hash races benignly (last rename wins, both
 * write identical bytes), and a reader of `destDir` never sees a partial tree.
 */
export function extractComputeArtifact(tarGzPath: string, destDir: string): void {
  const gz = fs.readFileSync(tarGzPath);
  const tar = zlib.gunzipSync(gz);
  const entries = readUstarEntries(tar);

  const parentDir = path.dirname(destDir);
  fs.mkdirSync(parentDir, { recursive: true });
  const tmpDir = path.join(parentDir, `.${path.basename(destDir)}.${crypto.randomUUID()}.tmp`);
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    for (const entry of entries) {
      const target = path.join(tmpDir, entry.relPath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, entry.content);
    }
    fs.rmSync(destDir, { recursive: true, force: true });
    fs.renameSync(tmpDir, destDir);
  } catch (error) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw error;
  }
}
