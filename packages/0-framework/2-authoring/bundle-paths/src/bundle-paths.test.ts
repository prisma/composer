import { describe, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertBundleSymlinksStayInside,
  copyTreeVerbatim,
  createBundleLink,
  isWithin,
  planBundleLink,
  repairWindowsDirectorySymlinks,
} from './bundle-paths.ts';

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-paths-'));

/** Where a link points relative to `root`, POSIX-separated (a junction reads back absolute). */
function linkTargetWithin(root: string, linkPath: string): string {
  const resolved = path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath));
  return path.relative(root, resolved).split(path.sep).join('/');
}

async function symlinkTypesDuring(run: () => Promise<void>): Promise<unknown[]> {
  const spy = spyOn(fs.promises, 'symlink');
  try {
    await run();
    return spy.mock.calls.map((call) => call[2]);
  } finally {
    spy.mockRestore();
  }
}

function writeStore(root: string): void {
  fs.mkdirSync(path.join(root, 'store', 'pkg'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(root, 'store', 'pkg', 'index.js'), '// pkg');
}

describe('isWithin', () => {
  test('the root itself and descendants are within; siblings and parents are not', () => {
    expect(isWithin('/a/b', '/a/b')).toBe(true);
    expect(isWithin('/a/b', '/a/b/c/d')).toBe(true);
    expect(isWithin('/a/b', '/a')).toBe(false);
    expect(isWithin('/a/b', '/a/c')).toBe(false);
    expect(isWithin('/a/b', '/a/b-evil')).toBe(false);
    expect(isWithin('/a/b', '/a/b/../c')).toBe(false);
  });
});

describe('assertBundleSymlinksStayInside', () => {
  test('accepts a bundle whose links resolve inside it', async () => {
    const bundle = path.join(scratch(), 'bundle');
    fs.mkdirSync(path.join(bundle, 'real'), { recursive: true });
    fs.symlinkSync(path.join('.', 'real'), path.join(bundle, 'link'));

    await assertBundleSymlinksStayInside(bundle);
  });

  test('rejects a dangling link', async () => {
    const bundle = path.join(scratch(), 'bundle');
    fs.mkdirSync(bundle, { recursive: true });
    fs.symlinkSync('./missing', path.join(bundle, 'link'));

    await expect(assertBundleSymlinksStayInside(bundle)).rejects.toThrow('dangling symlink');
  });

  test('rejects a link whose target escapes the bundle', async () => {
    const parent = scratch();
    const bundle = path.join(parent, 'bundle');
    fs.mkdirSync(path.join(parent, 'outside'), { recursive: true });
    fs.mkdirSync(bundle, { recursive: true });
    fs.symlinkSync('../outside', path.join(bundle, 'link'));

    await expect(assertBundleSymlinksStayInside(bundle)).rejects.toThrow('escapes the bundle');
  });
});

describe('planBundleLink', () => {
  const linkPath = path.join(path.resolve('bundle'), 'node_modules', 'pkg');
  const target = path.join('..', 'store', 'pkg');

  test('a Windows directory link is a junction with an absolute target', () => {
    expect(planBundleLink(target, linkPath, 'dir', 'win32')).toEqual({
      target: path.join(path.resolve('bundle'), 'store', 'pkg'),
      type: 'junction',
    });
  });

  test('POSIX links and Windows file links are written as given', () => {
    expect(planBundleLink(target, linkPath, 'dir', 'linux')).toEqual({ target, type: 'dir' });
    expect(planBundleLink(target, linkPath, 'file', 'linux')).toEqual({ target, type: 'file' });
    expect(planBundleLink(target, linkPath, 'file', 'win32')).toEqual({ target, type: 'file' });
  });
});

describe('createBundleLink', () => {
  test('names the missing privilege when Windows refuses a file symlink', async () => {
    const link = path.join(scratch(), 'link');
    const denied = Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    const spy = spyOn(fs.promises, 'symlink').mockRejectedValue(denied);
    try {
      const refused = createBundleLink('file.txt', link, 'file', 'win32');
      await expect(refused).rejects.toThrow(/symbolic-link privilege.*Developer Mode/s);
      await expect(refused).rejects.toHaveProperty('cause', denied);
      await expect(createBundleLink('real', link, 'dir', 'win32')).rejects.toBe(denied);
      expect(spy.mock.calls.length).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });

  test.skipIf(process.platform !== 'win32')(
    'a directory link on Windows is a junction',
    async () => {
      const bundle = path.join(scratch(), 'bundle');
      writeStore(bundle);
      const link = path.join(bundle, 'node_modules', 'pkg');

      const types = await symlinkTypesDuring(() =>
        createBundleLink(path.join('..', 'store', 'pkg'), link, 'dir'),
      );

      expect(types).toEqual(['junction']);
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(path.isAbsolute(fs.readlinkSync(link))).toBe(true);
      expect(linkTargetWithin(bundle, link)).toBe('store/pkg');
      expect(fs.readFileSync(path.join(link, 'index.js'), 'utf8')).toBe('// pkg');
      await assertBundleSymlinksStayInside(bundle);
    },
  );
});

describe('copyTreeVerbatim', () => {
  test('the Windows copy requests only junctions and file links, re-anchoring in-tree absolute targets', async () => {
    const parent = scratch();
    fs.mkdirSync(path.join(parent, 'real'));
    fs.symlinkSync(path.join(parent, 'real'), path.join(parent, 'alias'), 'dir');
    const source = path.join(parent, 'alias', 'source');
    const destination = path.join(parent, 'destination');
    writeStore(source);
    const link = (name: string, target: string, type: 'dir' | 'file' = 'dir') =>
      fs.symlinkSync(target, path.join(source, 'node_modules', name), type);
    link('relative', path.join('..', 'store', 'pkg'));
    link('given', path.join(source, 'store', 'pkg'));
    link('real', path.join(await fs.promises.realpath(source), 'store', 'pkg'));
    link('file.js', path.join('..', 'store', 'pkg', 'index.js'), 'file');
    link('late', path.join('..', 'store', 'late.txt'));
    const copied = (name: string) => path.join(destination, 'node_modules', name);
    fs.mkdirSync(path.dirname(copied('relative')), { recursive: true });
    fs.symlinkSync('stale', copied('relative'), 'dir');

    const types = await symlinkTypesDuring(async () => {
      await copyTreeVerbatim(source, destination, 'win32');
      await copyTreeVerbatim(
        path.join(source, 'node_modules', 'file.js'),
        copied('again.js'),
        'win32',
      );
    });

    expect([...types].sort()).toEqual([
      'file',
      'file',
      'junction',
      'junction',
      'junction',
      'junction',
    ]);
    for (const name of ['relative', 'given', 'real']) {
      expect(linkTargetWithin(destination, copied(name))).toBe('store/pkg');
    }
    expect(fs.readFileSync(copied('again.js'), 'utf8')).toBe('// pkg');

    fs.writeFileSync(path.join(destination, 'store', 'late.txt'), 'staged');
    await repairWindowsDirectorySymlinks(destination, 'win32');
    expect(fs.readFileSync(copied('late'), 'utf8')).toBe('staged');
  });

  test.skipIf(process.platform !== 'win32')(
    'copies a tree of real junctions without creating a directory symlink',
    async () => {
      const parent = scratch();
      const source = path.join(parent, 'source');
      const destination = path.join(parent, 'destination');
      writeStore(source);
      fs.symlinkSync(
        path.join(source, 'store', 'pkg'),
        path.join(source, 'node_modules', 'pkg'),
        'junction',
      );

      const types = await symlinkTypesDuring(() => copyTreeVerbatim(source, destination));

      expect(types).toEqual(['junction']);
      const copied = path.join(destination, 'node_modules', 'pkg');
      expect(linkTargetWithin(destination, copied)).toBe('store/pkg');
      expect(fs.readFileSync(path.join(copied, 'index.js'), 'utf8')).toBe('// pkg');
      await assertBundleSymlinksStayInside(destination);
    },
  );
});
