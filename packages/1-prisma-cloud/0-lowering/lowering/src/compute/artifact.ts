/**
 * Assembles a Prisma Compute artifact: the app-built bundle plus the
 * extension-printed bootstrap and manifest, tarred and gzipped deterministically
 * (fixed mtimes, sorted entry order) so an unchanged service noops on
 * redeploy — a rebuild is the only thing that changes the hash. Lives here
 * (not in @prisma/composer-prisma-cloud/control) because it needs node:fs/node:zlib,
 * which the extension's shipped src may never import (invariant 5).
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

export interface PackageComputeArtifactOptions {
  /** The service's provision id — namespaces the temp output path. */
  readonly id: string;
  /** The assembled bundle directory (wrapper + app entry + fixups). */
  readonly bundleDir: string;
  /** The Prisma App wrapper file inside bundleDir. Defaults to main.js|main.mjs. */
  readonly bundleEntry?: string;
  /**
   * The app's own runnable inside bundleDir (e.g. "server.js") — baked into the
   * bootstrap's boot import: `main.run(address, () => import("./<appEntry>"))`.
   */
  readonly appEntry: string;
  /** The node's deployment address — baked into the printed bootstrap. */
  readonly address: string;
}

export interface ComputeArtifact {
  readonly path: string;
  readonly sha256: string;
}

const MANIFEST_VERSION = '1';

/** Finds main.js/main.mjs in a bundle dir when no explicit entry is given. */
function resolveEntry(bundleDir: string, entry: string | undefined): string {
  if (entry !== undefined) return entry;
  const found = fs.readdirSync(bundleDir).find((f) => /^main\.m?js$/.test(f));
  if (found === undefined) {
    throw new Error(`no main.js/main.mjs found in bundle dir ${bundleDir}`);
  }
  return found;
}

/** All files under `dir`, as dir-relative POSIX paths, in sorted order. A
 * symlink is a hard error: deploy bundles must be flat (ADR-0005), and the
 * user's build owns flattening — dereferencing here would relink the tree and
 * risk packaging files from outside it. */
function walkFiles(dir: string): string[] {
  const out: string[] = [];
  const visit = (sub: string): void => {
    for (const entry of fs.readdirSync(path.join(dir, sub), { withFileTypes: true })) {
      const rel = sub.length > 0 ? `${sub}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        throw new Error(
          `bundle contains a symlink at ${rel} — deploy bundles must be flat; ` +
            'materialize links in your build (e.g. cp -RL) so the tree is self-contained.',
        );
      }
      if (entry.isDirectory()) visit(rel);
      else out.push(rel);
    }
  };
  visit('');
  return out.sort();
}

// ——— A minimal, deterministic USTAR writer: fixed mtime (epoch 0), fixed
// mode/uid/gid, sorted entries. gzip (node:zlib) is itself deterministic —
// its header carries no timestamp — so byte-identical inputs always hash
// identically.

function octal(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, '0')}\0`;
}

/** Splits a path into ustar's name (<=100 bytes) + prefix (<=155 bytes) fields. */
function splitUstarPath(relPath: string): { name: string; prefix: string } {
  if (Buffer.byteLength(relPath, 'utf8') <= 100) return { name: relPath, prefix: '' };
  for (let i = relPath.length - 1; i >= 0; i--) {
    if (relPath[i] !== '/') continue;
    const prefix = relPath.slice(0, i);
    const name = relPath.slice(i + 1);
    if (Buffer.byteLength(prefix, 'utf8') <= 155 && Buffer.byteLength(name, 'utf8') <= 100) {
      return { name, prefix };
    }
  }
  throw new Error(`path too long for a ustar tar entry: ${relPath}`);
}

function ustarHeader(relPath: string, size: number): Buffer {
  const { name, prefix } = splitUstarPath(relPath);
  const buf = Buffer.alloc(512);
  buf.write(name, 0, 100, 'utf8');
  buf.write(octal(0o644, 8), 100, 8, 'utf8'); // mode
  buf.write(octal(0, 8), 108, 8, 'utf8'); // uid
  buf.write(octal(0, 8), 116, 8, 'utf8'); // gid
  buf.write(octal(size, 12), 124, 12, 'utf8');
  buf.write(octal(0, 12), 136, 12, 'utf8'); // mtime: fixed at epoch 0
  buf.write('        ', 148, 8, 'utf8'); // chksum placeholder (8 spaces)
  buf.write('0', 156, 1, 'utf8'); // typeflag: regular file
  buf.write('ustar\0', 257, 6, 'utf8');
  buf.write('00', 263, 2, 'utf8');
  buf.write(prefix, 345, 155, 'utf8');

  let sum = 0;
  for (const b of buf) sum += b;
  buf.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8');
  return buf;
}

function createDeterministicTarGz(
  entries: readonly { relPath: string; content: Buffer }[],
): Buffer {
  const sorted = [...entries].sort((a, b) => a.relPath.localeCompare(b.relPath));
  const chunks: Buffer[] = [];
  for (const entry of sorted) {
    chunks.push(ustarHeader(entry.relPath, entry.content.length));
    chunks.push(entry.content);
    const pad = (512 - (entry.content.length % 512)) % 512;
    if (pad > 0) chunks.push(Buffer.alloc(pad));
  }
  chunks.push(Buffer.alloc(1024)); // end-of-archive: two zero blocks
  return zlib.gzipSync(Buffer.concat(chunks));
}

/**
 * Prints the bootstrap + manifest and tars them with the bundle into a
 * deterministic artifact. If bundleDir doesn't exist (e.g. `alchemy destroy`
 * run before any build), returns a placeholder rather than throwing — the
 * artifact is never read on destroy.
 */
export function packageComputeArtifact(opts: PackageComputeArtifactOptions): ComputeArtifact {
  if (!fs.existsSync(opts.bundleDir)) {
    // Destroy-only tolerance: `alchemy destroy` never uploads the artifact, so
    // packaging must not require a prior build. A build-less DEPLOY still fails
    // later — the Deployment provider's readFileSync hits ENOENT on this empty
    // path. An explicit up-front guard belongs in the deploy entrypoint (the
    // prisma-composer deploy CLI), which is deferred.
    return { path: '', sha256: 'absent' };
  }

  const entryFile = resolveEntry(opts.bundleDir, opts.bundleEntry);
  const bootstrap = `import main from "./${entryFile}";\nawait main.run(${JSON.stringify(opts.address)}, () => import(${JSON.stringify(`./${opts.appEntry}`)}));\n`;
  // `address` is intrinsic artifact metadata, not dev config — bootstrap.js
  // above already bakes `main.run(address, …)`, so the manifest carrying it
  // too is the same fact recorded twice: once for the boot path, once for a
  // reader that needs the address WITHOUT executing the artifact (the local
  // Deployment provider, which learns nothing else about dev — local-dev
  // spec § 4). No version bump — no consumer needs protecting from a new
  // field; the platform still reads only `entrypoint`.
  const manifest = `${JSON.stringify(
    { manifestVersion: MANIFEST_VERSION, entrypoint: 'bootstrap.js', address: opts.address },
    null,
    2,
  )}\n`;

  const files = walkFiles(opts.bundleDir).map((relPath) => ({
    relPath,
    content: fs.readFileSync(path.join(opts.bundleDir, relPath)),
  }));
  files.push({ relPath: 'bootstrap.js', content: Buffer.from(bootstrap, 'utf8') });
  files.push({ relPath: 'compute.manifest.json', content: Buffer.from(manifest, 'utf8') });
  // Disable bun's runtime auto-install for every Compute artifact. An app's
  // build produces a self-contained entry with its dependencies inlined
  // (ADR-0005), so nothing needs fetching at boot; this guards against a stray
  // optional `require` (e.g. a Next standalone's `sharp`/`@next/swc`) making
  // bun fetch a linux binary at boot and fill the tiny disk (ENOSPC -> reboot
  // loop). bun reads bunfig from the process CWD, which is the artifact root
  // at boot.
  files.push({
    relPath: 'bunfig.toml',
    content: Buffer.from('[install]\nauto = "disable"\n', 'utf8'),
  });

  const gz = createDeterministicTarGz(files);
  const sha256 = crypto.createHash('sha256').update(gz).digest('hex');

  // The output path must be content-addressed AND per-user. Content-addressed
  // because `artifactPath` is a Deployment prop: a path that varies per call
  // (e.g. mkdtemp) makes every redeploy diff as an update even when the bytes
  // are identical, breaking the redeploy-noop guarantee. Per-user because a
  // fixed shared dir under os.tmpdir() is owned by whichever OS user creates
  // it first — everyone else's writes fail EACCES. Same content → same path
  // (noop); new build → new hash → new path (update, as designed). uid is -1
  // on Windows — still a valid, deterministic directory name.
  const outDir = path.join(
    os.tmpdir(),
    `prisma-composer-compute-${String(os.userInfo().uid)}`,
    sha256.slice(0, 16),
  );
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${opts.id}.tar.gz`);
  // Write-then-rename so concurrent same-content runs race benignly: each
  // writes identical bytes to its own temp file and the rename atomically
  // replaces, never exposing a half-written artifact.
  const tmpPath = path.join(outDir, `.${opts.id}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(tmpPath, gz);
  fs.renameSync(tmpPath, outPath);

  return { path: outPath, sha256 };
}
