import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { assemble } from '../assemble.ts';

const tmpDirs: string[] = [];

function makeServiceDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'makerkit-node-assemble-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('assemble()', () => {
  test('rejects a non-node build adapter', async () => {
    const serviceDir = makeServiceDir();
    await expect(
      assemble({
        serviceDir,
        serviceModule: path.join(serviceDir, 'src', 'service.ts'),
        build: { kind: 'nextjs', entry: 'server.js' },
      }),
    ).rejects.toThrow(/expected a "node" build adapter/);
  });

  test('rejects when the declared build entry is missing — names the expected path', async () => {
    const serviceDir = makeServiceDir();
    await expect(
      assemble({
        serviceDir,
        serviceModule: path.join(serviceDir, 'src', 'service.ts'),
        build: { kind: 'node', entry: 'dist/server.js' },
      }),
    ).rejects.toThrow(/no built entry at .*dist\/server\.js/);
  });

  test('rejects an app entry named main.js — reserved for the wrapper', async () => {
    const serviceDir = makeServiceDir();
    fs.mkdirSync(path.join(serviceDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(serviceDir, 'dist', 'main.js'), 'export {};\n');
    await expect(
      assemble({
        serviceDir,
        serviceModule: path.join(serviceDir, 'src', 'service.ts'),
        build: { kind: 'node', entry: 'dist/main.js' },
      }),
    ).rejects.toThrow(/reserved for the MakerKit wrapper/);
  });

  test('produces a bundle dir containing the wrapper and a copy of the built entry', async () => {
    const serviceDir = makeServiceDir();
    fs.mkdirSync(path.join(serviceDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(serviceDir, 'dist', 'server.js'), 'export default "app-entry";\n');
    fs.mkdirSync(path.join(serviceDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(serviceDir, 'src', 'service.ts'),
      'export default { hello: "wrapper" as const };\n',
    );

    const result = await assemble({
      serviceDir,
      serviceModule: path.join(serviceDir, 'src', 'service.ts'),
      build: { kind: 'node', entry: 'dist/server.js' },
    });

    expect(result.dir).toBe(path.join(serviceDir, 'dist', 'bundle'));
    expect(result.entry).toBe('server.js');
    expect(fs.existsSync(path.join(result.dir, 'server.js'))).toBe(true);
    const hasWrapper =
      fs.existsSync(path.join(result.dir, 'main.js')) ||
      fs.existsSync(path.join(result.dir, 'main.mjs'));
    expect(hasWrapper).toBe(true);
    // The copied entry is untouched — same module instance as the user's build.
    expect(fs.readFileSync(path.join(result.dir, 'server.js'), 'utf8')).toContain('app-entry');
  }, 20_000);
});
