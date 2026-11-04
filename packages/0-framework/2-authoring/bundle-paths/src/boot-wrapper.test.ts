import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildBootWrapper } from './boot-wrapper.ts';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

async function wrapperFor(source: string): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-wrapper-'));
  dirs.push(dir);
  const serviceModule = path.join(dir, 'service.mjs');
  fs.writeFileSync(serviceModule, source);
  const workDir = path.join(dir, 'out');
  await buildBootWrapper(serviceModule, workDir);
  return path.join(workDir, 'main.mjs');
}

const serviceUsingTheOrm = [
  "import ormPostgresRuntime from '@prisma/orm-postgres/runtime';",
  "import { contractFromJson } from '@prisma/orm-postgres/static';",
  'export const declared = "the service node";',
  'export const buildClient = () => ormPostgresRuntime({ contract: contractFromJson({}) });',
].join('\n');

describe('buildBootWrapper', () => {
  test('writes main.mjs without a copy of Prisma ORM, so the app runnable holds the only one', async () => {
    const main = await wrapperFor(serviceUsingTheOrm);

    const code = fs.readFileSync(main, 'utf8');
    expect(code).not.toContain('node_modules/@prisma/orm-');
    expect(code).not.toContain('MULTIPLE_ORM_COPIES');
  });

  test('the wrapper loads and reads its declarations without running any ORM code', async () => {
    const main = await wrapperFor(serviceUsingTheOrm);

    const wrapper = await import(pathToFileURL(main).href);

    expect(wrapper.declared).toBe('the service node');
  });

  test('calling Prisma ORM from the wrapper fails with an error that names the import', async () => {
    const main = await wrapperFor(serviceUsingTheOrm);
    const wrapper = await import(pathToFileURL(main).href);

    expect(() => wrapper.buildClient()).toThrow(
      "Composer's boot wrapper does not load Prisma ORM, but it called an export of @prisma/orm-postgres/static: contractFromJson",
    );
  });
});
