import { afterEach, expect, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import { emulatorRegistryRoot } from '../exports/local-target.ts';

const saved = process.env['PRISMA_COMPOSER_EMULATORS_DIR'];

afterEach(() => {
  if (saved === undefined) delete process.env['PRISMA_COMPOSER_EMULATORS_DIR'];
  else process.env['PRISMA_COMPOSER_EMULATORS_DIR'] = saved;
});

test('the local-target entry resolves the emulator directory PRISMA_COMPOSER_EMULATORS_DIR names', () => {
  const dir = path.join(os.tmpdir(), 'composer-emulators');
  process.env['PRISMA_COMPOSER_EMULATORS_DIR'] = dir;
  expect(emulatorRegistryRoot()).toBe(dir);
});
