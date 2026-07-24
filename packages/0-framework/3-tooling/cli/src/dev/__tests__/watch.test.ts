import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { startWatch, watchTargetsFrom } from '../watch.ts';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cli-watch-'));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls until `cond` holds or the deadline passes — assertions stay exact, only the waiting adapts to a loaded runner. */
async function until(cond: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) await sleep(25);
}

describe('watchTargetsFrom()', () => {
  test('a bundle with no watch field is reported unwatchable, not a target', () => {
    const { targets, unwatchable } = watchTargetsFrom({
      web: { dir: '/tmp/web', entry: 'server.js' },
    });
    expect(targets).toEqual([]);
    expect(unwatchable).toEqual(['web']);
  });
});

describe('startWatch()', () => {
  test('debounces a burst of changes across several files into one callback, 300ms after the last change', async () => {
    const dir = tempDir();
    const fileA = path.join(dir, 'a.txt');
    const fileB = path.join(dir, 'b.txt');
    fs.writeFileSync(fileA, 'a');
    fs.writeFileSync(fileB, 'b');

    let calls = 0;
    const watch = startWatch(
      [
        { address: 'a', paths: [fileA] },
        { address: 'b', paths: [fileB] },
      ],
      () => {
        calls += 1;
      },
    );
    await watch.ready;

    try {
      // A burst across both files, all inside the 300ms debounce window.
      fs.writeFileSync(fileA, 'a2');
      await sleep(50);
      fs.writeFileSync(fileB, 'b2');
      await sleep(50);
      fs.writeFileSync(fileA, 'a3');

      // Still inside the debounce window from the last write — no callback yet.
      await sleep(100);
      expect(calls).toBe(0);

      // Past the 300ms debounce from the last write.
      await until(() => calls === 1, 2000);
      expect(calls).toBe(1);
    } finally {
      watch.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

  test('a stopped watch fires no further callbacks', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'a.txt');
    fs.writeFileSync(file, 'a');

    let calls = 0;
    const watch = startWatch([{ address: 'a', paths: [file] }], () => {
      calls += 1;
    });
    watch.stop();

    fs.writeFileSync(file, 'a2');
    await sleep(500);
    expect(calls).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 10_000);

  test('survives a delete-then-recreate rebuild of the watched file (rm -rf && bun build --outfile)', async () => {
    // A single-file `fs.watch` bound to the original inode goes silently
    // dead after the file is unlinked and a new one created at the same
    // path — exactly what `rm -rf dist && bun build --outfile dist/x.mjs`
    // does on every rebuild. Found live against examples/store's catalog
    // service during the S5 proving pass; the fix at the time was a
    // hand-rolled parent-directory watch, since replaced by chokidar
    // (design tip 74272d8), which absorbs this class of rename/inode-swap
    // itself. The regression this test guards against is unchanged, so its
    // assertions stay exactly as they were — only the engine underneath
    // changed.
    const dir = tempDir();
    const file = path.join(dir, 'server.mjs');
    fs.writeFileSync(file, 'v1');

    let calls = 0;
    const watch = startWatch([{ address: 'catalog', paths: [file] }], () => {
      calls += 1;
    });
    // chokidar attaches its OS-level watches asynchronously — a change made
    // before `ready` can be missed entirely, so wait for real attachment
    // rather than guessing a grace period.
    await watch.ready;

    try {
      fs.rmSync(file);
      fs.writeFileSync(file, 'v2');
      await until(() => calls === 1, 3000);
      expect(calls).toBe(1);

      // A SECOND delete+recreate — the exact case that broke a
      // file-bound (not directory-bound) watch.
      fs.rmSync(file);
      fs.writeFileSync(file, 'v3');
      await until(() => calls === 2, 3000);
      expect(calls).toBe(2);
    } finally {
      watch.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);
});
