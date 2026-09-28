import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertBundleSymlinksStayInside,
  bundleLinkStrategy,
  copyTreeVerbatim,
  createBundleLink,
  isWithin,
} from './bundle-paths.ts';

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

describe('bundleLinkStrategy', () => {
  test('unix keeps ordinary symlinks for files and directories', () => {
    expect(bundleLinkStrategy('darwin', 'dir')).toBe('symlink');
    expect(bundleLinkStrategy('linux', 'file')).toBe('symlink');
  });

  test('windows uses junctions for directories and a copy fallback for files', () => {
    expect(bundleLinkStrategy('win32', 'dir')).toBe('junction');
    expect(bundleLinkStrategy('win32', 'file')).toBe('symlink-with-copy-fallback');
  });
});

describe('assertBundleSymlinksStayInside', () => {
  const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-paths-'));

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

describe('copyTreeVerbatim', () => {
  const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-paths-cp-'));

  test('preserves an in-tree directory symlink so the assembled bundle still validates', async () => {
    const source = path.join(scratch(), 'source');
    const destination = path.join(scratch(), 'destination');
    fs.mkdirSync(path.join(source, 'pg-abc123'), { recursive: true });
    fs.writeFileSync(path.join(source, 'pg-abc123', 'index.js'), 'export {}\n');
    fs.symlinkSync('pg-abc123', path.join(source, 'pg'));

    await copyTreeVerbatim(source, destination);

    const linkPath = path.join(destination, 'pg');
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
    // Windows junctions store an absolute target; unix keeps the relative one.
    const rawTarget = fs.readlinkSync(linkPath);
    expect(path.resolve(path.dirname(linkPath), rawTarget)).toBe(
      path.resolve(destination, 'pg-abc123'),
    );
    if (process.platform !== 'win32') {
      expect(rawTarget).toBe('pg-abc123');
    }
    await assertBundleSymlinksStayInside(destination);
  });

  test('remaps an absolute in-source directory link into the destination tree', async () => {
    // pnpm on Windows creates junctions with absolute targets. Copying those
    // verbatim leaves them pointing at the source — the escape assert's failure.
    const source = path.join(scratch(), 'source');
    const destination = path.join(scratch(), 'destination');
    const realDir = path.join(source, 'node_modules', '.pnpm', 'pkg@1', 'node_modules', 'pkg');
    fs.mkdirSync(realDir, { recursive: true });
    fs.writeFileSync(path.join(realDir, 'index.js'), 'export {}\n');
    fs.mkdirSync(path.join(source, 'node_modules'), { recursive: true });
    fs.symlinkSync(realDir, path.join(source, 'node_modules', 'pkg'), 'dir');

    await copyTreeVerbatim(source, destination);

    const linkPath = path.join(destination, 'node_modules', 'pkg');
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath))).toBe(
      path.resolve(destination, 'node_modules', '.pnpm', 'pkg@1', 'node_modules', 'pkg'),
    );
    expect(fs.readFileSync(path.join(linkPath, 'index.js'), 'utf8')).toContain('export');
    await assertBundleSymlinksStayInside(destination);
  });
});

describe('createBundleLink', () => {
  const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-paths-link-'));

  test('creates a relative directory symlink on non-windows platforms', async () => {
    if (process.platform === 'win32') return;

    const root = scratch();
    fs.mkdirSync(path.join(root, 'pg-abc123'), { recursive: true });
    const linkPath = path.join(root, 'pg');
    await createBundleLink(linkPath, 'pg-abc123', 'dir', {
      resolvedTarget: path.join(root, 'pg-abc123'),
      platform: 'linux',
    });

    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(linkPath)).toBe('pg-abc123');
  });

  test('on windows, a directory link is a junction that resolves inside the bundle', async () => {
    if (process.platform !== 'win32') return;

    const root = scratch();
    const targetDir = path.join(root, 'pg-abc123');
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'index.js'), 'export {}\n');
    const linkPath = path.join(root, 'pg');

    await createBundleLink(linkPath, 'pg-abc123', 'dir', {
      resolvedTarget: targetDir,
    });

    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(linkPath, 'index.js'))).toBe(true);
    await assertBundleSymlinksStayInside(root);
  });
});
