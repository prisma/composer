/** `--fresh`'s removal of the dev state directory keeps what other apps run from the directory still use. */
import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EMULATOR_INSTANCES_FILE } from '../emulator-instances.ts';
import { removeAppDevState } from '../teardown.ts';

function filesUnder(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .sort();
}

test("keeps the record and other apps' bucket objects, and removes the rest", () => {
  const devDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-target-teardown-'));
  const files = [
    EMULATOR_INSTANCES_FILE,
    'env.json',
    'secrets.json',
    'alchemy.run.ts',
    path.join('artifacts', 'abc123', 'bootstrap.js'),
    path.join('buckets', 'shop', 'uploads', 'mine.txt'),
    path.join('buckets', 'other', 'uploads', 'theirs.txt'),
  ];
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(devDir, file)), { recursive: true });
    fs.writeFileSync(path.join(devDir, file), 'x');
  }

  removeAppDevState(devDir, 'shop');

  expect(filesUnder(devDir)).toEqual(
    [EMULATOR_INSTANCES_FILE, path.join('buckets', 'other', 'uploads', 'theirs.txt')].sort(),
  );
});

test('a dev state directory that does not exist is nothing to remove', () => {
  expect(() =>
    removeAppDevState(path.join(os.tmpdir(), 'never-created-dev-dir'), 'shop'),
  ).not.toThrow();
});
