/**
 * Discovery (walk-up) + real c12 evaluation of a `prisma-composer.config.ts` in a
 * temp tree, plus the field-by-field shape validation. The config file's
 * imports here are self-contained (no extension packages) — the resolution
 * proof against REAL extension /control entries lives in test/integration.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CliError } from '../cli-error.ts';
import {
  CONFIG_FILENAME,
  findConfigPathForEntry,
  loadAppConfig,
  validateConfigShape,
} from '../load-config.ts';

const tmpDirs: string[] = [];

function makeTree(): string {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-composer-cli-config-')),
  );
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

const VALID_CONFIG_SOURCE = `export default {
  extensions: [
    { id: 'fixture-extension', nodes: { compute: { kind: 'service' } } },
  ],
  state: { extension: 'fixture-extension', create: () => ({ fixture: 'state' }) },
};
`;

describe('findConfigPathForEntry() — the walk-up', () => {
  test('finds the config beside the entry', () => {
    const dir = makeTree();
    const configPath = path.join(dir, CONFIG_FILENAME);
    fs.writeFileSync(configPath, VALID_CONFIG_SOURCE);
    const entry = path.join(dir, 'module.ts');

    expect(findConfigPathForEntry(entry)).toBe(configPath);
  });

  test('walks UP from a nested entry to an ancestor config', () => {
    const dir = makeTree();
    const configPath = path.join(dir, CONFIG_FILENAME);
    fs.writeFileSync(configPath, VALID_CONFIG_SOURCE);
    const entry = path.join(dir, 'apps', 'shop', 'src', 'module.ts');

    expect(findConfigPathForEntry(entry)).toBe(configPath);
  });

  test('the NEAREST config wins when several ancestors carry one', () => {
    const dir = makeTree();
    fs.writeFileSync(path.join(dir, CONFIG_FILENAME), VALID_CONFIG_SOURCE);
    const appDir = path.join(dir, 'apps', 'shop');
    fs.mkdirSync(appDir, { recursive: true });
    const nearest = path.join(appDir, CONFIG_FILENAME);
    fs.writeFileSync(nearest, VALID_CONFIG_SOURCE);

    expect(findConfigPathForEntry(path.join(appDir, 'module.ts'))).toBe(nearest);
  });

  test('returns undefined when no ancestor carries the config', () => {
    const dir = makeTree();
    expect(findConfigPathForEntry(path.join(dir, 'module.ts'))).toBeUndefined();
  });
});

describe('loadAppConfig() — real c12 evaluation', () => {
  test('loads and validates a well-formed config file', async () => {
    const dir = makeTree();
    const configPath = path.join(dir, CONFIG_FILENAME);
    fs.writeFileSync(configPath, VALID_CONFIG_SOURCE);

    const loaded = await loadAppConfig(configPath);

    expect(loaded.path).toBe(configPath);
    expect(loaded.config.extensions).toHaveLength(1);
    expect(loaded.config.extensions[0]?.id).toBe('fixture-extension');
    expect(loaded.config.state.extension).toBe('fixture-extension');
    expect(typeof loaded.config.state.create).toBe('function');
  });

  test('a config file whose factory throws (e.g. missing env) propagates that error', async () => {
    const dir = makeTree();
    const configPath = path.join(dir, CONFIG_FILENAME);
    fs.writeFileSync(
      configPath,
      "throw new Error('prismaCloud(): environment variable PRISMA_WORKSPACE_ID is required.');\n",
    );

    await expect(loadAppConfig(configPath)).rejects.toThrow(/PRISMA_WORKSPACE_ID/);
  });
});

describe('validateConfigShape() — field-by-field CliErrors', () => {
  const configPath = '/repo/app/prisma-composer.config.ts';

  test('an empty export is a CliError naming defineConfig', () => {
    expect(() => validateConfigShape({}, configPath)).toThrow(CliError);
    expect(() => validateConfigShape({}, configPath)).toThrow(/defineConfig/);
  });

  test('a non-array `extensions` is a CliError naming the field', () => {
    expect(() =>
      validateConfigShape({ extensions: 'nope', state: () => ({}) }, configPath),
    ).toThrow(/`extensions` must be an array/);
  });

  test('a descriptor without an id is a CliError naming the entry', () => {
    expect(() =>
      validateConfigShape({ extensions: [{ nodes: {} }], state: () => ({}) }, configPath),
    ).toThrow(/`extensions\[0\]\.id` must be a non-empty string/);
  });

  test('a descriptor without a nodes registry is a CliError naming the entry', () => {
    expect(() =>
      validateConfigShape({ extensions: [{ id: '@x/y' }], state: () => ({}) }, configPath),
    ).toThrow(/`extensions\[0\]\.nodes` must be an object/);
  });

  test('a duplicated extension id is a CliError naming it', () => {
    expect(() =>
      validateConfigShape(
        {
          extensions: [
            { id: '@x/y', nodes: {} },
            { id: '@x/y', nodes: {} },
          ],
          state: { extension: 'fixture-extension', create: () => ({}) },
        },
        configPath,
      ),
    ).toThrow(/extension "@x\/y" is listed more than once/);
  });

  test('a missing `state` is a CliError naming the field and the shape', () => {
    expect(() =>
      validateConfigShape({ extensions: [{ id: '@x/y', nodes: {} }] }, configPath),
    ).toThrow(/`state` must be a state descriptor/);
  });

  test('a `state` that is a bare function (the old shape) is a CliError naming the field and the shape', () => {
    expect(() =>
      validateConfigShape(
        { extensions: [{ id: '@x/y', nodes: {} }], state: () => ({}) },
        configPath,
      ),
    ).toThrow(/`state` must be a state descriptor/);
  });
});
