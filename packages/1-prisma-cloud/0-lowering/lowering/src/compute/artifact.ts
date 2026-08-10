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

interface WalkedFile {
  readonly type: 'file';
  readonly relPath: string;
}

interface WalkedSymlink {
  readonly type: 'symlink';
  readonly relPath: string;
  readonly linkTarget: string;
}

type WalkedEntry = WalkedFile | WalkedSymlink;

function isWithin(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
}

/**
 * All files and safe relative symlinks under `dir`, as dir-relative POSIX
 * paths, in sorted order. Links remain links: dereferencing pnpm's layout
 * changes Node/Bun resolution semantics. Their lexical targets must remain
 * inside the artifact, but may be dangling because framework tracers can omit
 * an unused package while retaining its package-manager alias (ADR-0047).
 */
function walkEntries(dir: string): WalkedEntry[] {
  const root = path.resolve(dir);
  const out: WalkedEntry[] = [];
  const visit = (sub: string): void => {
    for (const entry of fs.readdirSync(path.join(dir, sub), { withFileTypes: true })) {
      const rel = sub.length > 0 ? `${sub}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        const source = path.join(dir, rel);
        const target = fs.readlinkSync(source);
        if (
          path.isAbsolute(target) ||
          /^[a-zA-Z]:/.test(target) ||
          (path.sep === '/' && target.includes('\\'))
        ) {
          throw new Error(`bundle contains an unsafe absolute symlink at ${rel}: ${target}`);
        }
        const resolvedTarget = path.resolve(path.dirname(source), target);
        if (!isWithin(root, resolvedTarget)) {
          throw new Error(
            `bundle contains a symlink at ${rel} whose target escapes the artifact: ${target}`,
          );
        }
        out.push({
          type: 'symlink',
          relPath: rel,
          linkTarget: target.replaceAll(path.sep, '/'),
        });
      } else if (entry.isDirectory()) {
        visit(rel);
      } else if (entry.isFile()) {
        out.push({ type: 'file', relPath: rel });
      } else {
        throw new Error(`bundle contains an unsupported filesystem entry at ${rel}`);
      }
    }
  };
  visit('');
  return out.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
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

function ustarHeader(
  relPath: string,
  size: number,
  options: { readonly type?: 'file' | 'symlink' | 'pax'; readonly linkTarget?: string } = {},
): Buffer {
  const { name, prefix } = splitUstarPath(relPath);
  const buf = Buffer.alloc(512);
  buf.write(name, 0, 100, 'utf8');
  buf.write(octal(options.type === 'symlink' ? 0o777 : 0o644, 8), 100, 8, 'utf8'); // mode
  buf.write(octal(0, 8), 108, 8, 'utf8'); // uid
  buf.write(octal(0, 8), 116, 8, 'utf8'); // gid
  buf.write(octal(size, 12), 124, 12, 'utf8');
  buf.write(octal(0, 12), 136, 12, 'utf8'); // mtime: fixed at epoch 0
  buf.write('        ', 148, 8, 'utf8'); // chksum placeholder (8 spaces)
  const typeflag = options.type === 'symlink' ? '2' : options.type === 'pax' ? 'x' : '0';
  buf.write(typeflag, 156, 1, 'utf8');
  if (options.linkTarget !== undefined) {
    buf.write(options.linkTarget, 157, 100, 'utf8');
  }
  buf.write('ustar\0', 257, 6, 'utf8');
  buf.write('00', 263, 2, 'utf8');
  buf.write(prefix, 345, 155, 'utf8');

  let sum = 0;
  for (const b of buf) sum += b;
  buf.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8');
  return buf;
}

interface FileTarEntry {
  readonly type: 'file';
  readonly relPath: string;
  readonly content: Buffer;
}

interface SymlinkTarEntry {
  readonly type: 'symlink';
  readonly relPath: string;
  readonly linkTarget: string;
}

type TarEntry = FileTarEntry | SymlinkTarEntry;

function appendContent(chunks: Buffer[], content: Buffer): void {
  chunks.push(content);
  const pad = (512 - (content.length % 512)) % 512;
  if (pad > 0) chunks.push(Buffer.alloc(pad));
}

/** POSIX.1-2001 PAX record, used when a symlink target exceeds ustar's 100-byte field. */
function paxRecord(key: string, value: string): Buffer {
  const body = `${key}=${value}\n`;
  let length = Buffer.byteLength(body, 'utf8') + 3;
  while (true) {
    const record = `${String(length)} ${body}`;
    const actual = Buffer.byteLength(record, 'utf8');
    if (actual === length) return Buffer.from(record, 'utf8');
    length = actual;
  }
}

function createDeterministicTarGz(entries: readonly TarEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) =>
    a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0,
  );
  const chunks: Buffer[] = [];
  for (const entry of sorted) {
    if (entry.type === 'symlink') {
      const shortTarget =
        Buffer.byteLength(entry.linkTarget, 'utf8') <= 100 ? entry.linkTarget : undefined;
      if (shortTarget === undefined) {
        const pax = paxRecord('linkpath', entry.linkTarget);
        const paxName = `PaxHeaders/${crypto
          .createHash('sha256')
          .update(entry.relPath)
          .digest('hex')
          .slice(0, 24)}`;
        chunks.push(ustarHeader(paxName, pax.length, { type: 'pax' }));
        appendContent(chunks, pax);
      }
      chunks.push(
        ustarHeader(entry.relPath, 0, {
          type: 'symlink',
          // libarchive and npm's `tar` use this conventional marker to
          // identify the following PAX `linkpath` as the real long target.
          // An empty ustar linkname is treated as an invalid symlink before
          // the extended header can override it.
          linkTarget: shortTarget ?? '././@LongSymLink',
        }),
      );
      continue;
    }
    chunks.push(ustarHeader(entry.relPath, entry.content.length));
    appendContent(chunks, entry.content);
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

  const entries: TarEntry[] = walkEntries(opts.bundleDir).map((entry) =>
    entry.type === 'symlink'
      ? entry
      : {
          type: 'file',
          relPath: entry.relPath,
          content: fs.readFileSync(path.join(opts.bundleDir, entry.relPath)),
        },
  );
  entries.push({
    type: 'file',
    relPath: 'bootstrap.js',
    content: Buffer.from(bootstrap, 'utf8'),
  });
  entries.push({
    type: 'file',
    relPath: 'compute.manifest.json',
    content: Buffer.from(manifest, 'utf8'),
  });
  // Disable bun's runtime auto-install for every Compute artifact. An app's
  // build produces a self-contained entry with its dependencies inlined
  // (ADR-0005), so nothing needs fetching at boot; this guards against a stray
  // optional `require` (e.g. a Next standalone's `sharp`/`@next/swc`) making
  // bun fetch a linux binary at boot and fill the tiny disk (ENOSPC -> reboot
  // loop). bun reads bunfig from the process CWD, which is the artifact root
  // at boot.
  entries.push({
    type: 'file',
    relPath: 'bunfig.toml',
    content: Buffer.from('[install]\nauto = "disable"\n', 'utf8'),
  });

  const gz = createDeterministicTarGz(entries);
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
