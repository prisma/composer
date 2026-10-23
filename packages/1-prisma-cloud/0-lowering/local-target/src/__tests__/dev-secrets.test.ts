import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readOrCreateFingerprintKey } from '../dev-secrets.ts';

let devDir: string;

beforeEach(() => {
  devDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'local-target-dev-secrets-')), 'dev');
});

afterEach(() => {
  fs.rmSync(path.dirname(devDir), { recursive: true, force: true });
});

test('two first runs that create the key at the same time get the same key', async () => {
  const keys = await Promise.all(
    Array.from({ length: 8 }, () => readOrCreateFingerprintKey(devDir)),
  );

  for (const key of keys) expect(key).toEqual(keys[0] ?? new Uint8Array());
  expect(fs.readdirSync(devDir)).toEqual(['fingerprint.key']);
});

test('a later run reads the key the first run created', async () => {
  const first = await readOrCreateFingerprintKey(devDir);

  expect(await readOrCreateFingerprintKey(devDir)).toEqual(first);
});
