import { afterEach, expect, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import { EMULATORS_DIR_ENV, emulatorRegistryRoot } from '../exports/local-target.ts';

const saved = process.env[EMULATORS_DIR_ENV];

afterEach(() => {
  if (saved === undefined) delete process.env[EMULATORS_DIR_ENV];
  else process.env[EMULATORS_DIR_ENV] = saved;
});

test('the local-target entry names the emulator directory variable', () => {
  expect(EMULATORS_DIR_ENV).toBe('PRISMA_COMPOSER_EMULATORS_DIR');
});

test('the local-target entry resolves the emulator directory the variable names', () => {
  const dir = path.join(os.tmpdir(), 'composer-emulators');
  process.env[EMULATORS_DIR_ENV] = dir;
  expect(emulatorRegistryRoot()).toBe(dir);
});
