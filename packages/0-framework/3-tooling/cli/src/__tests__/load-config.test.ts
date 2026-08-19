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
import { CliStructuredError } from '@internal/foundation/errors';
import {
  CONFIG_FILENAME,
  CONFIG_FILENAMES,
  findConfigPathForEntry,
  loadAppConfig,
  resolveConfigFile,
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

  test.each(CONFIG_FILENAMES.filter((name) => name !== CONFIG_FILENAME))(
    'finds a %s beside the entry when no .ts spelling exists',
    (filename) => {
      const dir = makeTree();
      const configPath = path.join(dir, filename);
      fs.writeFileSync(configPath, VALID_CONFIG_SOURCE);

      expect(findConfigPathForEntry(path.join(dir, 'module.mjs'))).toBe(configPath);
    },
  );

  test('the .ts spelling wins over the JavaScript spellings in the same directory', () => {
    const dir = makeTree();
    for (const filename of CONFIG_FILENAMES) {
      fs.writeFileSync(path.join(dir, filename), VALID_CONFIG_SOURCE);
    }

    expect(findConfigPathForEntry(path.join(dir, 'module.ts'))).toBe(
      path.join(dir, CONFIG_FILENAME),
    );
  });

  test('the NEAREST directory wins before spelling precedence', () => {
    const dir = makeTree();
    fs.writeFileSync(path.join(dir, CONFIG_FILENAME), VALID_CONFIG_SOURCE);
    const appDir = path.join(dir, 'apps', 'shop');
    fs.mkdirSync(appDir, { recursive: true });
    const nearest = path.join(appDir, 'prisma-composer.config.mjs');
    fs.writeFileSync(nearest, VALID_CONFIG_SOURCE);

    expect(findConfigPathForEntry(path.join(appDir, 'module.mjs'))).toBe(nearest);
  });

  test('the missing-config error names every accepted spelling', () => {
    const dir = makeTree();
    const error: unknown = (() => {
      try {
        resolveConfigFile({ entryPath: path.join(dir, 'module.ts') });
      } catch (thrown: unknown) {
        return thrown;
      }
      return undefined;
    })();

    if (!CliStructuredError.is(error)) throw new Error('expected a structured error');
    expect(error.code).toBe('CONFIG.FILE_MISSING');
    expect(error.message).toContain('prisma-composer.config.{ts,mts,mjs,js}');
  });
});

describe('resolveConfigFile() — which file a load will use', () => {
  test('a relative configPath resolves against the cwd the command runs in', () => {
    const dir = makeTree();
    const appDir = path.join(dir, 'apps', 'shop');
    fs.mkdirSync(appDir, { recursive: true });
    const configPath = path.join(appDir, CONFIG_FILENAME);
    fs.writeFileSync(configPath, VALID_CONFIG_SOURCE);

    const resolved = resolveConfigFile({
      entryPath: path.join(dir, 'module.ts'),
      configPath: `./apps/shop/${CONFIG_FILENAME}`,
      cwd: dir,
    });

    expect(resolved.path).toBe(configPath);
    expect(resolved.explicit).toBe(true);
  });

  test('an absolute configPath is used as given', () => {
    const dir = makeTree();
    const configPath = path.join(dir, CONFIG_FILENAME);
    fs.writeFileSync(configPath, VALID_CONFIG_SOURCE);

    expect(
      resolveConfigFile({ entryPath: path.join(dir, 'module.ts'), configPath, cwd: dir }).path,
    ).toBe(configPath);
  });

  test('a configPath naming a file that is not there is CONFIG.FILE_MISSING, not a fallback walk', () => {
    const dir = makeTree();
    fs.writeFileSync(path.join(dir, CONFIG_FILENAME), VALID_CONFIG_SOURCE);

    const error: unknown = (() => {
      try {
        resolveConfigFile({
          entryPath: path.join(dir, 'module.ts'),
          configPath: './not-here.config.ts',
          cwd: dir,
        });
      } catch (thrown: unknown) {
        return thrown;
      }
      return undefined;
    })();

    if (!CliStructuredError.is(error)) throw new Error('expected a structured error');
    expect(error.code).toBe('CONFIG.FILE_MISSING');
    expect(error.message).toContain(path.join(dir, 'not-here.config.ts'));
  });

  test('with no configPath it is the entry-anchored walk, and the walk is not explicit', () => {
    const dir = makeTree();
    const configPath = path.join(dir, CONFIG_FILENAME);
    fs.writeFileSync(configPath, VALID_CONFIG_SOURCE);

    const resolved = resolveConfigFile({
      entryPath: path.join(dir, 'apps', 'shop', 'module.ts'),
      cwd: dir,
    });

    expect(resolved.path).toBe(configPath);
    expect(resolved.explicit).toBe(false);
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

  test('loads a prisma-composer.config.mjs the same way', async () => {
    const dir = makeTree();
    const configPath = path.join(dir, 'prisma-composer.config.mjs');
    fs.writeFileSync(configPath, VALID_CONFIG_SOURCE);

    const loaded = await loadAppConfig(configPath);

    expect(loaded.path).toBe(configPath);
    expect(loaded.config.extensions[0]?.id).toBe('fixture-extension');
    expect(typeof loaded.config.state.create).toBe('function');
  });

  test('shape diagnostics name the file that was loaded, not the canonical .ts spelling', async () => {
    const dir = makeTree();
    const configPath = path.join(dir, 'prisma-composer.config.mjs');
    fs.writeFileSync(configPath, 'export default { extensions: "nope", state: {} };\n');

    const error: unknown = await loadAppConfig(configPath).catch((e: unknown) => e);

    if (!CliStructuredError.is(error)) throw new Error('expected a structured error');
    expect(error.code).toBe('CONFIG.FIELD_INVALID');
    expect(error.message).toContain('prisma-composer.config.mjs: `extensions` must be an array');
  });

  test('a config file whose factory throws (e.g. missing env) propagates that error', async () => {
    const dir = makeTree();
    const configPath = path.join(dir, CONFIG_FILENAME);
    fs.writeFileSync(
      configPath,
      "throw new Error('exampleExtension(): environment variable EXAMPLE_API_TOKEN is required.');\n",
    );

    await expect(loadAppConfig(configPath)).rejects.toThrow(/EXAMPLE_API_TOKEN/);
  });

  test('a throwing config module is CONFIG.EVALUATION_FAILED carrying the config path and the cause', async () => {
    const dir = makeTree();
    const configPath = path.join(dir, CONFIG_FILENAME);
    fs.writeFileSync(configPath, "throw new Error('config module blew up');\n");

    const error: unknown = await loadAppConfig(configPath).catch((e: unknown) => e);

    expect(CliStructuredError.is(error)).toBe(true);
    if (!CliStructuredError.is(error)) throw new Error('unreachable');
    expect(error.code).toBe('CONFIG.EVALUATION_FAILED');
    expect(error.message).toContain('config module blew up');
    expect(error.where?.path).toBe(configPath);
    expect(error.cause).toBeInstanceOf(Error);
  });
});

describe('validateConfigShape() — field-by-field CliErrors', () => {
  const configPath = '/repo/app/prisma-composer.config.ts';

  test('an empty export is a structured error whose fix names defineConfig', () => {
    expect(() => validateConfigShape({}, configPath)).toThrow(CliStructuredError);
    try {
      validateConfigShape({}, configPath);
    } catch (error) {
      if (!CliStructuredError.is(error)) throw new Error('expected a structured error');
      expect(error.code).toBe('CONFIG.EXPORT_INVALID');
      expect(error.fix).toContain('defineConfig');
    }
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
