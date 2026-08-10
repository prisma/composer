import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { packageComputeArtifact } from '../compute/artifact.ts';

function makeBundle(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

/** Un-gzips and inspects regular files and symlinks, including PAX linkpath records. */
function readTar(gz: Buffer): {
  names: string[];
  read: (name: string) => string;
  readLink: (name: string) => string | undefined;
} {
  const tar = zlib.gunzipSync(gz);
  const names: string[] = [];
  const contents = new Map<string, string>();
  const links = new Map<string, string>();
  let pendingPaxLink: string | undefined;
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break; // end-of-archive block
    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const rawPrefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '');
    const name = rawPrefix.length > 0 ? `${rawPrefix}/${rawName}` : rawName;
    const typeflag = header.subarray(156, 157).toString('utf8');
    const headerLink = header.subarray(157, 257).toString('utf8').replace(/\0.*$/s, '');
    const size = Number.parseInt(
      header.subarray(124, 136).toString('utf8').replace(/\0.*$/s, '').trim(),
      8,
    );
    offset += 512;
    const content = tar.subarray(offset, offset + size).toString('utf8');
    if (typeflag === 'x') {
      pendingPaxLink = /^\d+ linkpath=(.*)\n$/s.exec(content)?.[1];
    } else {
      names.push(name);
      if (typeflag === '2') links.set(name, pendingPaxLink ?? headerLink);
      else contents.set(name, content);
      pendingPaxLink = undefined;
    }
    offset += Math.ceil(size / 512) * 512;
  }
  return {
    names,
    read: (name: string) => contents.get(name) ?? '',
    readLink: (name: string) => links.get(name),
  };
}

describe('packageComputeArtifact', () => {
  test('prints a bootstrap that statically imports only the wrapper, then dynamically imports the app entry', () => {
    const bundleDir = makeBundle({ 'main.js': 'export default { run: async () => {} };' });

    const artifact = packageComputeArtifact({
      id: 'auth',
      bundleDir,
      appEntry: 'server.js',
      address: 'auth',
    });
    const { read } = readTar(fs.readFileSync(artifact.path));
    const bootstrap = read('bootstrap.js');

    const importLines = bootstrap.split('\n').filter((line) => /^\s*import\b/.test(line));
    expect(importLines).toEqual(['import main from "./main.js";']);
    expect(bootstrap).toContain('await main.run("auth", () => import("./server.js"));');
  });

  test('writes compute.manifest.json with entrypoint bootstrap.js and the packaged address', () => {
    const bundleDir = makeBundle({ 'main.js': 'export default {};' });

    const artifact = packageComputeArtifact({
      id: 'hello',
      bundleDir,
      appEntry: 'server.js',
      address: 'auth',
    });
    const { read } = readTar(fs.readFileSync(artifact.path));

    expect(JSON.parse(read('compute.manifest.json'))).toEqual({
      manifestVersion: '1',
      entrypoint: 'bootstrap.js',
      address: 'auth',
    });
  });

  test('auto-detects main.mjs when main.js is absent', () => {
    const bundleDir = makeBundle({ 'main.mjs': 'export default {};' });

    const artifact = packageComputeArtifact({
      id: 'storefront',
      bundleDir,
      appEntry: 'server.js',
      address: 'storefront',
    });
    const { read } = readTar(fs.readFileSync(artifact.path));

    expect(read('bootstrap.js')).toContain('import main from "./main.mjs";');
  });

  test('packaging twice with identical inputs yields an identical sha256 AND an identical path (redeploy noops)', () => {
    const bundleDir = makeBundle({
      'main.js': 'export default { run: async () => {} };',
      'nested/asset.txt': 'hello',
    });

    const first = packageComputeArtifact({
      id: 'auth',
      bundleDir,
      appEntry: 'server.js',
      address: 'auth',
    });
    const second = packageComputeArtifact({
      id: 'auth',
      bundleDir,
      appEntry: 'server.js',
      address: 'auth',
    });

    expect(first.sha256).toBe(second.sha256);
    // The path is a Deployment prop: it must be stable for identical content,
    // or every redeploy registers as an update instead of a noop.
    expect(first.path).toBe(second.path);
    expect(fs.readFileSync(first.path).equals(fs.readFileSync(second.path))).toBe(true);
  });

  test('different content yields a different path (a new build must register as an update)', () => {
    const a = packageComputeArtifact({
      id: 'auth',
      bundleDir: makeBundle({ 'main.js': 'export default {}; // v1' }),
      appEntry: 'server.js',
      address: 'auth',
    });
    const b = packageComputeArtifact({
      id: 'auth',
      bundleDir: makeBundle({ 'main.js': 'export default {}; // v2' }),
      appEntry: 'server.js',
      address: 'auth',
    });

    expect(a.sha256).not.toBe(b.sha256);
    expect(a.path).not.toBe(b.path);
  });

  test('the output path is namespaced per OS user, never the bare shared prisma-composer-compute dir', () => {
    const bundleDir = makeBundle({ 'main.js': 'export default {};' });

    const artifact = packageComputeArtifact({
      id: 'auth',
      bundleDir,
      appEntry: 'server.js',
      address: 'auth',
    });

    // A fixed os.tmpdir()/prisma-composer-compute dir is owned by whichever OS user
    // creates it first; every other user's writes then fail EACCES.
    const sharedDir = path.join(os.tmpdir(), 'prisma-composer-compute');
    expect(artifact.path.startsWith(`${sharedDir}${path.sep}`)).toBe(false);
    expect(artifact.path).toContain(`prisma-composer-compute-${String(os.userInfo().uid)}`);
  });

  test('a different address changes the hash (the bootstrap is address-specific)', () => {
    const bundleDir = makeBundle({ 'main.js': 'export default {};' });

    const a = packageComputeArtifact({
      id: 'auth',
      bundleDir,
      appEntry: 'server.js',
      address: 'auth',
    });
    const b = packageComputeArtifact({
      id: 'auth',
      bundleDir,
      appEntry: 'server.js',
      address: 'storefront',
    });

    expect(a.sha256).not.toBe(b.sha256);
  });

  test('a different appEntry changes the hash (the bootstrap bakes in the boot import)', () => {
    const bundleDir = makeBundle({ 'main.js': 'export default {};' });

    const a = packageComputeArtifact({
      id: 'auth',
      bundleDir,
      appEntry: 'server.js',
      address: 'auth',
    });
    const b = packageComputeArtifact({
      id: 'auth',
      bundleDir,
      appEntry: 'other-server.js',
      address: 'auth',
    });

    expect(a.sha256).not.toBe(b.sha256);
  });

  test('packages every bundle file, sorted, alongside the bootstrap and manifest', () => {
    const bundleDir = makeBundle({ 'main.js': 'export default {};', 'b.txt': 'b', 'a.txt': 'a' });

    const artifact = packageComputeArtifact({
      id: 'auth',
      bundleDir,
      appEntry: 'server.js',
      address: 'auth',
    });
    const { names } = readTar(fs.readFileSync(artifact.path));

    expect(names).toEqual([
      'a.txt',
      'b.txt',
      'bootstrap.js',
      'bunfig.toml',
      'compute.manifest.json',
      'main.js',
    ]);
  });

  test('injects bunfig.toml disabling bun auto-install into every artifact', () => {
    const bundleDir = makeBundle({ 'main.js': 'export default {};' });
    const artifact = packageComputeArtifact({
      id: 'auth',
      bundleDir,
      appEntry: 'server.js',
      address: 'auth',
    });
    const { read } = readTar(fs.readFileSync(artifact.path));
    expect(read('bunfig.toml')).toContain('auto = "disable"');
  });

  test('preserves a contained dangling symlink as a tar symlink', () => {
    const bundleDir = makeBundle({ 'main.js': 'export default {};' });
    fs.mkdirSync(path.join(bundleDir, 'node_modules'), { recursive: true });
    fs.symlinkSync('missing-package', path.join(bundleDir, 'node_modules', 'optional'));

    const artifact = packageComputeArtifact({
      id: 'auth',
      bundleDir,
      appEntry: 'server.js',
      address: 'auth',
    });
    const archive = readTar(fs.readFileSync(artifact.path));

    expect(archive.names).toContain('node_modules/optional');
    expect(archive.readLink('node_modules/optional')).toBe('missing-package');
  });

  test('uses a PAX linkpath record for pnpm targets longer than ustar linkname', () => {
    const packageDir = `next@16.2.9_${'peer'.repeat(30)}`;
    const linkTarget = `.pnpm/${packageDir}/node_modules/next`;
    const bundleDir = makeBundle({
      'main.js': 'export default {};',
      [`node_modules/${linkTarget}/index.js`]: '// next',
    });
    fs.symlinkSync(linkTarget, path.join(bundleDir, 'node_modules', 'next'));

    const artifact = packageComputeArtifact({
      id: 'web',
      bundleDir,
      appEntry: 'server.js',
      address: 'web',
    });
    const archive = readTar(fs.readFileSync(artifact.path));

    expect(Buffer.byteLength(linkTarget, 'utf8')).toBeGreaterThan(100);
    expect(archive.readLink('node_modules/next')).toBe(linkTarget);
  });

  test('rejects absolute and escaping symlink targets', () => {
    const absoluteBundle = makeBundle({ 'main.js': 'export default {};' });
    fs.symlinkSync('/private/machine-file', path.join(absoluteBundle, 'absolute'));
    expect(() =>
      packageComputeArtifact({
        id: 'auth',
        bundleDir: absoluteBundle,
        appEntry: 'server.js',
        address: 'auth',
      }),
    ).toThrow(/unsafe absolute symlink at absolute/);

    const escapingBundle = makeBundle({
      'main.js': 'export default {};',
      'nested/marker.txt': 'inside',
    });
    fs.symlinkSync('../../outside', path.join(escapingBundle, 'nested', 'escape'));
    expect(() =>
      packageComputeArtifact({
        id: 'auth',
        bundleDir: escapingBundle,
        appEntry: 'server.js',
        address: 'auth',
      }),
    ).toThrow(/target escapes the artifact/);
  });

  test('a missing bundle dir (destroy before any build) returns a placeholder instead of throwing', () => {
    const artifact = packageComputeArtifact({
      id: 'auth',
      bundleDir: path.join(os.tmpdir(), 'prisma-composer-artifact-test-does-not-exist'),
      appEntry: 'server.js',
      address: 'auth',
    });

    expect(artifact).toEqual({ path: '', sha256: 'absent' });
  });
});
