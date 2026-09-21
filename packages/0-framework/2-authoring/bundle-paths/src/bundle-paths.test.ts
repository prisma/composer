import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertBundleSymlinksStayInside,
  bundleLinkKind,
  copyTreeVerbatim,
  createBundleLink,
  isWithin,
  planBundleLink,
  repairWindowsDirectorySymlinks,
} from './bundle-paths.ts';

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-paths-'));
const onWindows = process.platform === 'win32';

/** Where a link points, relative to the root it lives under, POSIX-separated.
 * Platform-neutral: a Windows junction reads back as an absolute path. */
function linkTargetWithin(root: string, linkPath: string): string {
  const resolved = path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath));
  return path.relative(root, resolved).split(path.sep).join('/');
}

/** The `type` argument of every `fs.promises.symlink` call made while `run` executes. */
async function symlinkTypesDuring(run: () => Promise<void>): Promise<unknown[]> {
  const spy = spyOn(fs.promises, 'symlink');
  try {
    await run();
    return spy.mock.calls.map((call) => call[2]);
  } finally {
    spy.mockRestore();
  }
}

/** A tree holding each link shape a build output can contain. */
function writeLinkedTree(root: string): void {
  fs.mkdirSync(path.join(root, 'store', 'pkg'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(root, 'store', 'pkg', 'index.js'), '// pkg');
  fs.writeFileSync(path.join(root, 'store', 'data.json'), '{}');
  fs.symlinkSync(path.join('..', 'store', 'pkg'), path.join(root, 'node_modules', 'pkg'), 'dir');
  fs.symlinkSync(
    path.join('..', 'store', 'data.json'),
    path.join(root, 'node_modules', 'data.json'),
    'file',
  );
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

  test('POSIX writes the link exactly as given', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      expect(planBundleLink(target, linkPath, 'dir', platform)).toEqual({ target, type: 'dir' });
      expect(planBundleLink(target, linkPath, 'file', platform)).toEqual({ target, type: 'file' });
    }
  });

  test('a Windows directory link is a junction with an absolute target', () => {
    expect(planBundleLink(target, linkPath, 'dir', 'win32')).toEqual({
      target: path.join(path.resolve('bundle'), 'store', 'pkg'),
      type: 'junction',
    });
  });

  test('a Windows file link stays a file symlink with the target as given', () => {
    expect(planBundleLink(target, linkPath, 'file', 'win32')).toEqual({ target, type: 'file' });
  });
});

describe('bundleLinkKind', () => {
  test('types a link by what its target is, and an absent target as a directory', async () => {
    const root = scratch();
    fs.mkdirSync(path.join(root, 'dir'));
    fs.writeFileSync(path.join(root, 'file.txt'), 'x');

    expect(await bundleLinkKind(path.join(root, 'dir'))).toBe('dir');
    expect(await bundleLinkKind(path.join(root, 'file.txt'))).toBe('file');
    expect(await bundleLinkKind(path.join(root, 'absent'))).toBe('dir');
  });
});

describe('createBundleLink', () => {
  test('creates directory and file links that resolve inside the bundle', async () => {
    const bundle = path.join(scratch(), 'bundle');
    fs.mkdirSync(path.join(bundle, 'store', 'pkg'), { recursive: true });
    fs.mkdirSync(path.join(bundle, 'node_modules'));
    fs.writeFileSync(path.join(bundle, 'store', 'pkg', 'index.js'), '// pkg');
    const dirLink = path.join(bundle, 'node_modules', 'pkg');
    const fileLink = path.join(bundle, 'node_modules', 'index.js');

    await createBundleLink(path.join('..', 'store', 'pkg'), dirLink, 'dir');
    await createBundleLink(path.join('..', 'store', 'pkg', 'index.js'), fileLink, 'file');

    expect(fs.lstatSync(dirLink).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(fileLink).isSymbolicLink()).toBe(true);
    expect(linkTargetWithin(bundle, dirLink)).toBe('store/pkg');
    expect(linkTargetWithin(bundle, fileLink)).toBe('store/pkg/index.js');
    expect(fs.readFileSync(path.join(dirLink, 'index.js'), 'utf8')).toBe('// pkg');
    expect(fs.readFileSync(fileLink, 'utf8')).toBe('// pkg');
    await assertBundleSymlinksStayInside(bundle);
  });

  test('never asks Windows for a directory symlink', async () => {
    const bundle = path.join(scratch(), 'bundle');
    fs.mkdirSync(path.join(bundle, 'real'), { recursive: true });

    const types = await symlinkTypesDuring(() =>
      createBundleLink('real', path.join(bundle, 'link'), 'dir', 'win32'),
    );

    expect(types).toEqual(['junction']);
  });

  test('names the missing privilege when Windows refuses a file symlink, and nothing else', async () => {
    const bundle = path.join(scratch(), 'bundle');
    fs.mkdirSync(bundle, { recursive: true });
    const denied = Object.assign(new Error('EPERM: operation not permitted, symlink'), {
      code: 'EPERM',
    });
    const spy = spyOn(fs.promises, 'symlink').mockRejectedValue(denied);
    try {
      const fileLink = createBundleLink('file.txt', path.join(bundle, 'link'), 'file', 'win32');
      await expect(fileLink).rejects.toThrow(/symbolic-link privilege.*Developer Mode/s);
      await expect(fileLink).rejects.toHaveProperty('cause', denied);
      // Not a fallback: no second attempt is made, and any other refusal is
      // reported as it came.
      expect(spy.mock.calls.length).toBe(1);
      await expect(
        createBundleLink('real', path.join(bundle, 'junction'), 'dir', 'win32'),
      ).rejects.toBe(denied);
      await expect(
        createBundleLink('file.txt', path.join(bundle, 'posix'), 'file', 'linux'),
      ).rejects.toBe(denied);
    } finally {
      spy.mockRestore();
    }
  });

  test.skipIf(!onWindows)('a directory link on Windows is a junction', async () => {
    const bundle = path.join(scratch(), 'bundle');
    fs.mkdirSync(path.join(bundle, 'real'), { recursive: true });
    fs.writeFileSync(path.join(bundle, 'real', 'index.js'), '// real');
    const link = path.join(bundle, 'link');

    const types = await symlinkTypesDuring(() => createBundleLink('real', link, 'dir'));

    expect(types).toEqual(['junction']);
    // What the rest of the pipeline relies on: a junction is reported as a
    // symlink, and reads back as a plain absolute path inside the bundle.
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    const recorded = fs.readlinkSync(link);
    expect(path.isAbsolute(recorded)).toBe(true);
    expect(path.relative(bundle, recorded)).toBe('real');
    expect(fs.readFileSync(path.join(link, 'index.js'), 'utf8')).toBe('// real');
    expect(
      fs
        .readdirSync(bundle, { withFileTypes: true })
        .find((entry) => entry.name === 'link')
        ?.isSymbolicLink(),
    ).toBe(true);
    await assertBundleSymlinksStayInside(bundle);
  });

  test.skipIf(!onWindows)('a junction whose target escapes the bundle is rejected', async () => {
    const parent = scratch();
    const bundle = path.join(parent, 'bundle');
    fs.mkdirSync(path.join(parent, 'outside'), { recursive: true });
    fs.mkdirSync(bundle, { recursive: true });
    await createBundleLink(path.join('..', 'outside'), path.join(bundle, 'link'), 'dir');

    await expect(assertBundleSymlinksStayInside(bundle)).rejects.toThrow('escapes the bundle');
  });
});

describe('copyTreeVerbatim', () => {
  const copies: string[] = [];
  afterEach(() => {
    for (const dir of copies.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  test('keeps directory and file links as links that resolve inside the copy', async () => {
    const parent = scratch();
    copies.push(parent);
    const source = path.join(parent, 'source');
    const destination = path.join(parent, 'nested', 'destination');
    writeLinkedTree(source);

    await copyTreeVerbatim(source, destination);

    const dirLink = path.join(destination, 'node_modules', 'pkg');
    const fileLink = path.join(destination, 'node_modules', 'data.json');
    expect(fs.lstatSync(dirLink).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(fileLink).isSymbolicLink()).toBe(true);
    expect(linkTargetWithin(destination, dirLink)).toBe('store/pkg');
    expect(linkTargetWithin(destination, fileLink)).toBe('store/data.json');
    expect(fs.readFileSync(path.join(dirLink, 'index.js'), 'utf8')).toBe('// pkg');
    await assertBundleSymlinksStayInside(destination);
  });

  // The Windows copy, run on every platform: an absolute symlink stands in for
  // a junction, which is how `readlink` reports one.
  test('the Windows copy creates junctions and file links only, re-anchoring in-tree absolute targets', async () => {
    const parent = scratch();
    copies.push(parent);
    const source = path.join(parent, 'source');
    const destination = path.join(parent, 'destination');
    writeLinkedTree(source);
    fs.mkdirSync(path.join(parent, 'outside'));
    fs.symlinkSync(
      path.join(source, 'store', 'pkg'),
      path.join(source, 'node_modules', 'junction'),
      'dir',
    );
    fs.symlinkSync(
      path.join(parent, 'outside'),
      path.join(source, 'node_modules', 'escaping'),
      'dir',
    );
    fs.symlinkSync(
      path.join('..', 'store', 'absent'),
      path.join(source, 'node_modules', 'dangling'),
      'dir',
    );

    const types = await symlinkTypesDuring(() => copyTreeVerbatim(source, destination, 'win32'));

    expect([...types].sort()).toEqual(['file', 'junction', 'junction', 'junction', 'junction']);
    const copied = (name: string) => path.join(destination, 'node_modules', name);
    expect(linkTargetWithin(destination, copied('pkg'))).toBe('store/pkg');
    expect(linkTargetWithin(destination, copied('data.json'))).toBe('store/data.json');
    expect(linkTargetWithin(destination, copied('junction'))).toBe('store/pkg');
    expect(linkTargetWithin(destination, copied('dangling'))).toBe('store/absent');
    expect(linkTargetWithin(parent, copied('escaping'))).toBe('outside');
    expect(fs.readFileSync(path.join(copied('junction'), 'index.js'), 'utf8')).toBe('// pkg');
    expect(fs.readFileSync(path.join(destination, 'store', 'data.json'), 'utf8')).toBe('{}');
  });

  test('the Windows copy recognises an in-tree target spelled through the real path of the tree', async () => {
    const parent = scratch();
    copies.push(parent);
    // `source` reaches the tree through an aliased parent, as a short path or a
    // mapped drive would; the junction records the tree's real spelling.
    fs.mkdirSync(path.join(parent, 'real'));
    fs.symlinkSync(path.join(parent, 'real'), path.join(parent, 'alias'), 'dir');
    const source = path.join(parent, 'alias', 'source');
    const destination = path.join(parent, 'destination');
    writeLinkedTree(source);
    fs.symlinkSync(
      path.join(await fs.promises.realpath(source), 'store', 'pkg'),
      path.join(source, 'node_modules', 'junction'),
      'dir',
    );

    await copyTreeVerbatim(source, destination, 'win32');

    expect(linkTargetWithin(destination, path.join(destination, 'node_modules', 'junction'))).toBe(
      'store/pkg',
    );
  });

  test('the Windows copy replaces a link already at the destination and copies a single file or link', async () => {
    const parent = scratch();
    copies.push(parent);
    const source = path.join(parent, 'source');
    const destination = path.join(parent, 'destination');
    writeLinkedTree(source);
    fs.mkdirSync(path.join(destination, 'node_modules'), { recursive: true });
    fs.symlinkSync('stale', path.join(destination, 'node_modules', 'pkg'), 'dir');

    await copyTreeVerbatim(source, destination, 'win32');
    await copyTreeVerbatim(
      path.join(source, 'store', 'data.json'),
      path.join(parent, 'single', 'data.json'),
      'win32',
    );
    await copyTreeVerbatim(
      path.join(source, 'node_modules', 'data.json'),
      path.join(destination, 'node_modules', 'again.json'),
      'win32',
    );

    expect(linkTargetWithin(destination, path.join(destination, 'node_modules', 'pkg'))).toBe(
      'store/pkg',
    );
    expect(fs.readFileSync(path.join(parent, 'single', 'data.json'), 'utf8')).toBe('{}');
    expect(
      linkTargetWithin(destination, path.join(destination, 'node_modules', 'again.json')),
    ).toBe('store/data.json');
  });

  test.skipIf(!onWindows)(
    'copies a tree of real junctions without creating a directory symlink',
    async () => {
      const parent = scratch();
      copies.push(parent);
      const source = path.join(parent, 'source');
      const destination = path.join(parent, 'destination');
      fs.mkdirSync(path.join(source, 'store', 'pkg'), { recursive: true });
      fs.mkdirSync(path.join(source, 'node_modules'));
      fs.writeFileSync(path.join(source, 'store', 'pkg', 'index.js'), '// pkg');
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

describe('repairWindowsDirectorySymlinks', () => {
  test('re-types a link whose target arrived after it was created', async () => {
    const bundle = path.join(scratch(), 'bundle');
    fs.mkdirSync(bundle, { recursive: true });
    const lateFile = path.join(bundle, 'late-file');
    const lateDir = path.join(bundle, 'late-dir');
    const dangling = path.join(bundle, 'dangling');
    for (const [link, target] of [
      [lateFile, 'file.txt'],
      [lateDir, 'dir'],
      [dangling, 'absent'],
    ] as const) {
      await createBundleLink(
        target,
        link,
        await bundleLinkKind(path.join(bundle, target)),
        'win32',
      );
    }
    fs.writeFileSync(path.join(bundle, 'file.txt'), 'staged');
    fs.mkdirSync(path.join(bundle, 'dir'));

    const types = await symlinkTypesDuring(() => repairWindowsDirectorySymlinks(bundle, 'win32'));

    expect([...types].sort()).toEqual(['file', 'junction']);
    expect(fs.readFileSync(lateFile, 'utf8')).toBe('staged');
    expect(linkTargetWithin(bundle, lateDir)).toBe('dir');
    expect(linkTargetWithin(bundle, dangling)).toBe('absent');
  });

  test('leaves POSIX links alone', async () => {
    const bundle = path.join(scratch(), 'bundle');
    fs.mkdirSync(path.join(bundle, 'real'), { recursive: true });
    fs.symlinkSync('real', path.join(bundle, 'link'), 'dir');

    const types = await symlinkTypesDuring(() => repairWindowsDirectorySymlinks(bundle, 'linux'));

    expect(types).toEqual([]);
  });
});
