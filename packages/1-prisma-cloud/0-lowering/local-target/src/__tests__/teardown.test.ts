/** `--fresh`'s removal of the dev state directory keeps what other apps run from the directory still use. */
import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEV_ENVIRONMENT_NAME_FILE } from '@internal/core/config';
import { EMULATOR_INSTANCES_FILE } from '../emulator-instances.ts';
import { removeAlchemyStage, removeAppDevState } from '../teardown.ts';

function filesUnder(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .sort();
}

test("keeps the environment's name, the record and other apps' bucket objects, and removes the rest", () => {
  const devDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-target-teardown-'));
  const files = [
    DEV_ENVIRONMENT_NAME_FILE,
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
    [
      DEV_ENVIRONMENT_NAME_FILE,
      EMULATOR_INSTANCES_FILE,
      path.join('buckets', 'other', 'uploads', 'theirs.txt'),
    ].sort(),
  );
});

test('a dev state directory that does not exist is nothing to remove', () => {
  expect(() =>
    removeAppDevState(path.join(os.tmpdir(), 'never-created-dev-dir'), 'shop'),
  ).not.toThrow();
});

test('removing the Alchemy stage feature keeps the state of the stage feature/x nested in its folder', () => {
  const appState = fs.mkdtempSync(path.join(os.tmpdir(), 'local-target-alchemy-state-'));
  const files = [
    path.join('feature', 'shop__api.json'),
    path.join('feature', '__stack_output__.json'),
    path.join('feature', 'x', 'shop__api.json'),
    path.join('feature', 'x', '__stack_output__.json'),
  ];
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(appState, file)), { recursive: true });
    fs.writeFileSync(path.join(appState, file), '{}');
  }

  removeAlchemyStage(path.join(appState, 'feature'));

  expect(filesUnder(appState)).toEqual(
    [
      path.join('feature', 'x', '__stack_output__.json'),
      path.join('feature', 'x', 'shop__api.json'),
    ].sort(),
  );
});

test('removing an Alchemy stage with no nested stage removes its folder', () => {
  const appState = fs.mkdtempSync(path.join(os.tmpdir(), 'local-target-alchemy-state-'));
  fs.mkdirSync(path.join(appState, 'dev'));
  fs.writeFileSync(path.join(appState, 'dev', 'shop__api.json'), '{}');

  removeAlchemyStage(path.join(appState, 'dev'));

  expect(fs.readdirSync(appState)).toEqual([]);
});

test('an Alchemy stage that does not exist is nothing to remove', () => {
  expect(() => removeAlchemyStage(path.join(os.tmpdir(), 'never-created-stage'))).not.toThrow();
});
