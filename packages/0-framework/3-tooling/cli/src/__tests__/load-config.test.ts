/**
 * Discovery (walk-up) + real c12 evaluation of a `prisma-composer.config.ts` in a
 * temp tree, plus the field-by-field shape validation — which collects EVERY
 * problem as a diagnostics list instead of throwing on the first. The config
 * file's imports here are self-contained (no extension packages) — the
 * resolution proof against REAL extension /control entries lives in
 * test/integration.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CliStructuredError } from '@internal/foundation/errors';
import {
  CONFIG_FILENAME,
  collectConfigDiagnostics,
  combinedConfigFailure,
  findConfigPathForEntry,
  loadAppConfig,
  requireConfigSections,
} from '../load-config.ts';
import { renderErrorEnvelope } from '../render-error.ts';

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
  test('loads a well-formed config file with no diagnostics', async () => {
    const dir = makeTree();
    const configPath = path.join(dir, CONFIG_FILENAME);
    fs.writeFileSync(configPath, VALID_CONFIG_SOURCE);

    const loaded = await loadAppConfig(configPath);

    expect(loaded.path).toBe(configPath);
    expect(loaded.diagnostics).toHaveLength(0);
    const config = requireConfigSections(loaded, ['extensions', 'state']);
    expect(config.extensions).toHaveLength(1);
    expect(config.extensions[0]?.id).toBe('fixture-extension');
    expect(config.state.extension).toBe('fixture-extension');
    expect(typeof config.state.create).toBe('function');
  });

  test('a config file whose factory throws (e.g. missing env) is a diagnostic, not a throw', async () => {
    const dir = makeTree();
    const configPath = path.join(dir, CONFIG_FILENAME);
    fs.writeFileSync(
      configPath,
      "throw new Error('exampleExtension(): environment variable EXAMPLE_API_TOKEN is required.');\n",
    );

    const loaded = await loadAppConfig(configPath);
    expect(loaded.value).toBeUndefined();
    expect(loaded.diagnostics).toHaveLength(1);
    expect(loaded.diagnostics[0]?.message).toContain('EXAMPLE_API_TOKEN');
  });

  test('a throwing config module is ONE CONFIG.EVALUATION_FAILED diagnostic carrying the config path and the cause, fatal for every section', async () => {
    const dir = makeTree();
    const configPath = path.join(dir, CONFIG_FILENAME);
    fs.writeFileSync(configPath, "throw new Error('config module blew up');\n");

    const loaded = await loadAppConfig(configPath);

    expect(loaded.diagnostics).toHaveLength(1);
    const diagnostic = loaded.diagnostics[0];
    if (diagnostic === undefined) throw new Error('unreachable');
    expect(diagnostic.code).toBe('CONFIG.EVALUATION_FAILED');
    expect(diagnostic.message).toContain('config module blew up');
    expect(diagnostic.where?.path).toBe(configPath);
    expect(diagnostic.cause).toBeInstanceOf(Error);

    // Sectionless — every command fails early with it, whatever it reads.
    expect(() => requireConfigSections(loaded, ['extensions'])).toThrow(
      /Evaluating .* failed: config module blew up/,
    );
  });

  test('an invalid `state` blocks state readers but NOT an extensions-only reader', async () => {
    const dir = makeTree();
    const configPath = path.join(dir, CONFIG_FILENAME);
    fs.writeFileSync(
      configPath,
      `export default {
  extensions: [{ id: 'fixture-extension', nodes: {} }],
  state: () => ({}),
};
`,
    );

    const loaded = await loadAppConfig(configPath);
    expect(loaded.diagnostics).toHaveLength(1);
    expect(loaded.diagnostics[0]?.code).toBe('CONFIG.FIELD_INVALID');

    const config = requireConfigSections(loaded, ['extensions']);
    expect(config.extensions[0]?.id).toBe('fixture-extension');

    expect(() => requireConfigSections(loaded, ['extensions', 'state'])).toThrow(
      /`state` must be a state descriptor/,
    );
  });
});

describe('collectConfigDiagnostics() — field-by-field diagnostics', () => {
  const configPath = '/repo/app/prisma-composer.config.ts';

  function diagnosticsFor(loaded: unknown): CliStructuredError[] {
    return collectConfigDiagnostics(loaded, configPath);
  }

  test('an empty export is a structured diagnostic whose fix names defineConfig', () => {
    const diagnostics = diagnosticsFor({});
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe('CONFIG.EXPORT_INVALID');
    expect(diagnostics[0]?.fix).toContain('defineConfig');
    // Sectionless: an export-less config fails every command.
    expect(diagnostics[0]?.meta?.['section']).toBeUndefined();
  });

  test('a non-array `extensions` is a diagnostic naming the field and section', () => {
    const diagnostics = diagnosticsFor({ extensions: 'nope', state: () => ({}) });
    expect(diagnostics.map((d) => d.message).join('\n')).toMatch(/`extensions` must be an array/);
    expect(diagnostics[0]?.meta?.['section']).toBe('extensions');
  });

  test('a descriptor without an id is a diagnostic naming the entry', () => {
    const diagnostics = diagnosticsFor({ extensions: [{ nodes: {} }], state: () => ({}) });
    expect(diagnostics.map((d) => d.message).join('\n')).toMatch(
      /`extensions\[0\]\.id` must be a non-empty string/,
    );
  });

  test('a descriptor without a nodes registry is a diagnostic naming the entry', () => {
    const diagnostics = diagnosticsFor({ extensions: [{ id: '@x/y' }], state: () => ({}) });
    expect(diagnostics.map((d) => d.message).join('\n')).toMatch(
      /`extensions\[0\]\.nodes` must be an object/,
    );
  });

  test('a duplicated extension id is a diagnostic naming it', () => {
    const diagnostics = diagnosticsFor({
      extensions: [
        { id: '@x/y', nodes: {} },
        { id: '@x/y', nodes: {} },
      ],
      state: { extension: 'fixture-extension', create: () => ({}) },
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe('CONFIG.EXTENSION_DUPLICATE');
    expect(diagnostics[0]?.message).toMatch(/extension "@x\/y" is listed more than once/);
  });

  test('a missing `state` is a diagnostic naming the field and the shape', () => {
    const diagnostics = diagnosticsFor({ extensions: [{ id: '@x/y', nodes: {} }] });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toMatch(/`state` must be a state descriptor/);
    expect(diagnostics[0]?.meta?.['section']).toBe('state');
  });

  test('a `state` that is a bare function (the old shape) is a diagnostic naming the field and the shape', () => {
    const diagnostics = diagnosticsFor({
      extensions: [{ id: '@x/y', nodes: {} }],
      state: () => ({}),
    });
    expect(diagnostics.map((d) => d.message).join('\n')).toMatch(
      /`state` must be a state descriptor/,
    );
  });

  test('EVERY invalid field is collected — one bad field never hides the next', () => {
    const diagnostics = diagnosticsFor({
      extensions: [{ nodes: {} }, { id: '@x/y' }],
      state: () => ({}),
    });
    expect(diagnostics.map((d) => `${d.code} ${d.meta?.['field'] as string}`)).toEqual([
      'CONFIG.FIELD_INVALID extensions[0].id',
      'CONFIG.FIELD_INVALID extensions[1].nodes',
      'CONFIG.FIELD_INVALID state',
    ]);
  });
});

describe('combinedConfigFailure() — the one failure a command renders', () => {
  const configPath = '/repo/app/prisma-composer.config.ts';

  test('a single diagnostic surfaces as ITSELF — its own code stays the branching surface', () => {
    const diagnostics = collectConfigDiagnostics(
      { extensions: [{ id: '@x/y', nodes: {} }] },
      configPath,
    );
    const failure = combinedConfigFailure(diagnostics, configPath);
    expect(failure).toBe(diagnostics[0] as CliStructuredError);
    expect(failure.code).toBe('CONFIG.FIELD_INVALID');
  });

  test('several diagnostics combine into CONFIG.INVALID with meta.issues', () => {
    const diagnostics = collectConfigDiagnostics(
      { extensions: [{ nodes: {} }], state: () => ({}) },
      configPath,
    );
    const failure = combinedConfigFailure(diagnostics, configPath);
    expect(failure.code).toBe('CONFIG.INVALID');
    expect(failure.meta?.['issues']).toEqual([
      {
        kind: 'CONFIG.FIELD_INVALID',
        message:
          'prisma-composer.config.ts: `extensions[0].id` must be a non-empty string (the extension package name).',
      },
      {
        kind: 'CONFIG.FIELD_INVALID',
        message:
          'prisma-composer.config.ts: `state` must be a state descriptor (e.g. prismaState()).',
      },
    ]);
  });

  test('pins the rendered layout for a multi-diagnostic config failure', () => {
    const diagnostics = collectConfigDiagnostics(
      { extensions: [{ nodes: {} }], state: () => ({}) },
      configPath,
    );
    const rendered = renderErrorEnvelope(
      combinedConfigFailure(diagnostics, configPath).toEnvelope(),
    );
    expect(rendered).toBe(
      [
        '✖ prisma-composer.config.ts has 2 problems. (CONFIG.INVALID)',
        '  Fix: Fix each issue below.',
        '  Where: /repo/app/prisma-composer.config.ts',
        '  Issues:',
        '    - [CONFIG.FIELD_INVALID] prisma-composer.config.ts: `extensions[0].id` must be a non-empty string (the extension package name).',
        '    - [CONFIG.FIELD_INVALID] prisma-composer.config.ts: `state` must be a state descriptor (e.g. prismaState()).',
      ].join('\n'),
    );
  });

  test('pins the JSON envelope for a single-diagnostic config failure — framing identical to the pre-diagnostics rendering', () => {
    const diagnostics = collectConfigDiagnostics(
      { extensions: 'nope', state: { extension: 'x', create: () => ({}) } },
      configPath,
    );
    const envelope = combinedConfigFailure(diagnostics, configPath).toEnvelope();
    expect(envelope).toEqual({
      ok: false,
      code: 'CONFIG.FIELD_INVALID',
      severity: 'error',
      summary: 'prisma-composer.config.ts: `extensions` must be an array.',
      fix: "See defineConfig() in '@prisma/composer/config'.",
      meta: { section: 'extensions', field: 'extensions' },
    });
  });
});
