import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertBundleSymlinksStayInside, isWithin } from './bundle-paths.ts';

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
