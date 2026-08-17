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

/** Un-gzips and inspects the deterministic tar subset, without a tar library. */
function readTar(gz: Buffer): {
  names: string[];
  read: (name: string) => string;
  link: (name: string) => string | undefined;
} {
  const tar = zlib.gunzipSync(gz);
  const names: string[] = [];
  const contents = new Map<string, string>();
  const links = new Map<string, string>();
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break; // end-of-archive block
    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const rawPrefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '');
    const name = rawPrefix.length > 0 ? `${rawPrefix}/${rawName}` : rawName;
    const size = Number.parseInt(
      header.subarray(124, 136).toString('utf8').replace(/\0.*$/s, '').trim(),
      8,
    );
    const typeflag = header.subarray(156, 157).toString('utf8');
    const linkname = header.subarray(157, 257).toString('utf8').replace(/\0.*$/s, '');
    offset += 512;
    contents.set(name, tar.subarray(offset, offset + size).toString('utf8'));
    if (typeflag === '2') links.set(name, linkname);
    names.push(name);
    offset += Math.ceil(size / 512) * 512;
  }
  return {
    names,
    read: (name: string) => contents.get(name) ?? '',
    link: (name: string) => links.get(name),
  };
}

describe('packageComputeArtifact', () => {
  test('prints a constant bootstrap that reads data before dynamically importing the wrapper and app', () => {
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
    expect(importLines).toEqual(['import { readFile } from "node:fs/promises";']);
    expect(bootstrap).toContain('for (const constructor of [URL, URLSearchParams])');
    expect(bootstrap).toContain('Object.defineProperty(this, inspect');
    expect(bootstrap).toContain('const main = (await import(boot.moduleEntrypoint)).default;');
    expect(bootstrap).toContain('await main.run(boot.address, () => import(boot.appEntrypoint));');
    expect(JSON.parse(read('compute.bootstrap.json'))).toEqual({
      moduleEntrypoint: './main.js',
      appEntrypoint: './server.js',
      address: 'auth',
    });
  });

  test('executes the generated data-backed bootstrap under Bun', () => {
    const bundleDir = makeBundle({
      'main.js':
        'export default { run: async (address, boot) => { await boot(); console.log(`address:${address}`); } };',
      'server.js': 'console.log("server:booted");',
    });
    const artifact = packageComputeArtifact({
      id: 'executable',
      bundleDir,
      appEntry: 'server.js',
      address: 'auth',
    });
    const archive = readTar(fs.readFileSync(artifact.path));
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-bootstrap-run-'));
    for (const name of ['bootstrap.js', 'compute.bootstrap.json', 'main.js', 'server.js']) {
      fs.writeFileSync(path.join(runtimeDir, name), archive.read(name));
    }

    const child = Bun.spawnSync({ cmd: [process.execPath, 'bootstrap.js'], cwd: runtimeDir });
    const stdout = new TextDecoder().decode(child.stdout);
    const stderr = new TextDecoder().decode(child.stderr);

    expect(child.exitCode, stderr).toBe(0);
    expect(stdout).toContain('server:booted');
    expect(stdout).toContain('address:auth');
  });

  test('keeps caller-provided entry and address strings out of executable JavaScript', () => {
    const marker = 'globalThis.COMPROMISED = true';
    const bundleEntry = `main"; ${marker}; ".js`;
    const appEntry = `server"; ${marker}; ".js`;
    const address = `auth"); ${marker}; ("`;
    const bundleDir = makeBundle({
      [bundleEntry]: 'export default {};',
      [appEntry]: 'export default {};',
    });

    const artifact = packageComputeArtifact({
      id: 'hostile-data',
      bundleDir,
      bundleEntry,
      appEntry,
      address,
    });
    const { read } = readTar(fs.readFileSync(artifact.path));

    expect(read('bootstrap.js')).not.toContain(marker);
    expect(JSON.parse(read('compute.bootstrap.json'))).toEqual({
      moduleEntrypoint: `./${bundleEntry}`,
      appEntrypoint: `./${appEntry}`,
      address,
    });
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

    expect(JSON.parse(read('compute.bootstrap.json')).moduleEntrypoint).toBe('./main.mjs');
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

  test('a different address changes the hash (the bootstrap data is address-specific)', () => {
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

  test('a different appEntry changes the hash (the bootstrap data names the boot import)', () => {
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
      'compute.bootstrap.json',
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

  test('preserves a framework-produced symlink whose target stays inside the bundle', () => {
    const bundleDir = makeBundle({
      'main.js': 'export default {};',
      'node_modules/real/index.js': '// real',
    });
    // A bun/Next-standalone-shaped relative directory symlink.
    fs.symlinkSync('real', path.join(bundleDir, 'node_modules', 'link'));

    const artifact = packageComputeArtifact({
      id: 'auth',
      bundleDir,
      appEntry: 'server.js',
      address: 'auth',
    });
    const archive = readTar(fs.readFileSync(artifact.path));

    expect(archive.names).toContain('node_modules/link');
    expect(archive.link('node_modules/link')).toBe('real');
  });

  test('rejects a symlink whose real target escapes the assembled bundle', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-symlink-escape-'));
    const bundleDir = path.join(parent, 'bundle');
    fs.mkdirSync(bundleDir);
    fs.writeFileSync(path.join(bundleDir, 'main.js'), 'export default {};');
    fs.writeFileSync(path.join(parent, 'secret.txt'), 'must not ship');
    fs.symlinkSync('../secret.txt', path.join(bundleDir, 'escaped'));

    expect(() =>
      packageComputeArtifact({ id: 'auth', bundleDir, appEntry: 'server.js', address: 'auth' }),
    ).toThrow(/symlink at escaped escapes the bundle root/);
  });

  test('rejects a dangling symlink instead of emitting an unusable artifact', () => {
    const bundleDir = makeBundle({ 'main.js': 'export default {};' });
    fs.symlinkSync('missing.js', path.join(bundleDir, 'dangling'));

    expect(() =>
      packageComputeArtifact({ id: 'auth', bundleDir, appEntry: 'server.js', address: 'auth' }),
    ).toThrow(/symlink at dangling is dangling/);
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
