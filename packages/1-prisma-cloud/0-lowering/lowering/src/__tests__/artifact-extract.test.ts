import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { packageComputeArtifact } from '../compute/artifact.ts';
import { extractComputeArtifact } from '../compute/artifact-extract.ts';

function makeBundle(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-extract-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

function readAll(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (sub: string): void => {
    for (const entry of fs.readdirSync(path.join(dir, sub), { withFileTypes: true })) {
      const rel = sub.length > 0 ? `${sub}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(rel);
      else out[rel] = fs.readFileSync(path.join(dir, rel), 'utf8');
    }
  };
  walk('');
  return out;
}

describe('extractComputeArtifact', () => {
  test('round-trips packageComputeArtifact output: every packaged file lands byte-identical', () => {
    const bundleDir = makeBundle({
      'main.js': 'export default { run: async () => {} };',
      'nested/asset.txt': 'hello world',
    });
    const artifact = packageComputeArtifact({
      id: 'auth',
      bundleDir,
      appEntry: 'server.js',
      address: 'auth',
    });

    const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-extract-dest-'));
    fs.rmSync(destDir, { recursive: true, force: true }); // extractComputeArtifact creates it
    extractComputeArtifact(artifact.path, destDir);

    const extracted = readAll(destDir);
    expect(extracted['main.js']).toBe('export default { run: async () => {} };');
    expect(extracted['nested/asset.txt']).toBe('hello world');
    expect(extracted['bootstrap.js']).toContain(
      'await main.run("auth", () => import("./server.js"));',
    );
    expect(JSON.parse(extracted['compute.manifest.json'] ?? '{}')).toEqual({
      manifestVersion: '1',
      entrypoint: 'bootstrap.js',
    });
    expect(extracted['bunfig.toml']).toContain('auto = "disable"');
  });

  test('rejects a tar entry with a non-regular-file typeflag', () => {
    // Hand-build a one-entry ustar archive with typeflag '5' (directory) to
    // prove the reader rejects anything packageComputeArtifact never writes.
    const header = Buffer.alloc(512);
    header.write('somedir/', 0, 100, 'utf8');
    header.write('0000644\0', 100, 8, 'utf8');
    header.write('0000000\0', 108, 8, 'utf8');
    header.write('0000000\0', 116, 8, 'utf8');
    header.write('00000000000\0', 124, 12, 'utf8');
    header.write('00000000000\0', 136, 12, 'utf8');
    header.write('        ', 148, 8, 'utf8');
    header.write('5', 156, 1, 'utf8'); // typeflag: directory
    header.write('ustar\0', 257, 6, 'utf8');
    header.write('00', 263, 2, 'utf8');
    let sum = 0;
    for (const b of header) sum += b;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8');
    const tar = Buffer.concat([header, Buffer.alloc(1024)]);
    const gz = zlib.gzipSync(tar);

    const tmpGz = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-extract-bad-')),
      'bad.tar.gz',
    );
    fs.writeFileSync(tmpGz, gz);
    const destDir = path.join(path.dirname(tmpGz), 'dest');

    expect(() => extractComputeArtifact(tmpGz, destDir)).toThrow(/typeflag "5"/);
  });
});
