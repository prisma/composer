/**
 * The `composer` section's validator. It checks only the fields that identify
 * extension and state descriptors and hands every descriptor to the command
 * as the config file's own object. It must never throw: the engine turns a
 * throwing validator into an internal error, which would report a user's
 * typo as a bug in composer.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SectionProvenance, SectionValidation } from '@prisma/cli-engine';
import { composerSection } from '../section.ts';

const DECLARING_FILE = path.resolve(path.sep, 'repo', 'prisma.config.ts');

function provenance(file: string = DECLARING_FILE): SectionProvenance {
  return { files: [file], keys: { extensions: file, state: file } };
}

const NO_FILE: SectionProvenance = { files: [], keys: {} };

function extension(id: string) {
  return {
    id,
    nodes: { service: { kind: 'build', assemble: async () => ({}) } },
    providers: () => ({ layer: id }),
    preflight: async () => 'payload',
  };
}

function stateDescriptor() {
  return { extension: 'ext-a', create: () => ({ state: true }) };
}

function validSection() {
  return { extensions: [extension('ext-a'), extension('ext-b')], state: stateDescriptor() };
}

/** Widened so the assertions can compare against fakes that carry only the identifying fields. */
function validate(
  raw: unknown,
  from: SectionProvenance = provenance(),
): SectionValidation<{
  readonly value: { readonly extensions: readonly unknown[]; readonly state: unknown };
  readonly file: string;
}> {
  return composerSection.validate(raw, from);
}

const SECTION_FIX =
  "Write `composer: composer({ extensions: [...], state: ... })` in prisma.config.ts, with `import { defineConfig as composer } from '@prisma/composer/config'`.";

describe('composerSection.validate() on a well-formed section', () => {
  test('returns extensions and state together with the file that declared them', () => {
    const section = validSection();
    const result = validate(section);
    expect(result).toEqual({
      ok: true,
      value: { value: section, file: DECLARING_FILE },
      diagnostics: [],
    });
  });

  test('hands every descriptor to the command by reference, members untouched', () => {
    const section = validSection();
    const result = validate(section);
    if (!result.ok) throw new Error('expected the section to validate');
    expect(result.value.value.extensions[0]).toBe(section.extensions[0]);
    expect(result.value.value.extensions[1]).toBe(section.extensions[1]);
    expect(result.value.value.state).toBe(section.state);
  });

  test('accepts an empty extensions list', () => {
    const section = { extensions: [], state: stateDescriptor() };
    expect(validate(section)).toEqual({
      ok: true,
      value: { value: section, file: DECLARING_FILE },
      diagnostics: [],
    });
  });
});

describe('composerSection.validate() on an absent section', () => {
  /**
   * The engine calls the validator with `undefined` and an empty provenance
   * when no loaded file declares the section, so the message cannot name a
   * directory; it names the old file unconditionally instead.
   */
  test('fails, shows the section to write and says the old file is no longer read', () => {
    expect(validate(undefined, NO_FILE)).toEqual({
      ok: false,
      diagnostics: [
        {
          code: 'CONFIG.SECTION_MISSING',
          severity: 'error',
          summary: 'No loaded prisma.config.ts declares a `composer` section.',
          why: 'Composer reads its configuration only from the `composer` section of prisma.config.ts. A prisma-composer.config.ts file is no longer read.',
          nextActions: [
            {
              kind: 'edit-file',
              label: `${SECTION_FIX} If the project has a prisma-composer.config.ts, move its extensions and state into that section and delete the file.`,
            },
          ],
        },
      ],
    });
  });
});

describe('composerSection.validate() on the retired configPath field', () => {
  test('fails with its own diagnostic that shows the section to write', () => {
    expect(validate({ configPath: './prisma-composer.config.ts' })).toEqual({
      ok: false,
      diagnostics: [
        {
          code: 'CONFIG.FIELD_RETIRED',
          severity: 'error',
          summary:
            '`composer.configPath` is no longer supported: prisma-composer.config.ts is no longer read.',
          why: 'Composer reads its configuration only from the `composer` section of prisma.config.ts.',
          nextActions: [
            {
              kind: 'edit-file',
              label: `Replace \`configPath\` with the section itself. ${SECTION_FIX} If the project has a prisma-composer.config.ts, move its extensions and state into that section and delete the file.`,
            },
          ],
          where: { path: DECLARING_FILE },
          meta: { field: 'configPath' },
        },
      ],
    });
  });

  test('is the only finding, even when the rest of the section is valid', () => {
    const result = validate({ ...validSection(), configPath: './x.ts' });
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({ code: 'CONFIG.FIELD_RETIRED' });
  });
});

describe('composerSection.validate() on unknown fields', () => {
  test('an unknown field is an error naming the fields the section takes', () => {
    expect(validate({ ...validSection(), stage: 'prod' })).toEqual({
      ok: false,
      diagnostics: [
        {
          code: 'CONFIG.FIELD_UNKNOWN',
          severity: 'error',
          summary: 'The `composer` section has no field `stage`.',
          nextActions: [
            {
              kind: 'edit-file',
              label: 'Remove `stage`. The section takes only `extensions` and `state`.',
            },
          ],
          where: { path: DECLARING_FILE },
          meta: { field: 'stage' },
        },
      ],
    });
  });
});

describe('composerSection.validate() on the section itself', () => {
  test('a non-object section fails', () => {
    for (const raw of ['nope', 42, [], null, () => undefined]) {
      expect(validate(raw)).toEqual({
        ok: false,
        diagnostics: [
          {
            code: 'CONFIG.FIELD_INVALID',
            severity: 'error',
            summary: 'The `composer` section of prisma.config.ts must be an object.',
            nextActions: [{ kind: 'edit-file', label: SECTION_FIX }],
            where: { path: DECLARING_FILE },
          },
        ],
      });
    }
  });

  test('a section whose fields cannot be read fails instead of throwing', () => {
    const unreadable = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('ownKeys trap');
        },
      },
    );
    expect(validate(unreadable)).toEqual({
      ok: false,
      diagnostics: [
        {
          code: 'CONFIG.FIELD_INVALID',
          severity: 'error',
          summary: 'The `composer` section of prisma.config.ts could not be read.',
          why: 'Reading it threw: ownKeys trap',
          nextActions: [{ kind: 'edit-file', label: SECTION_FIX }],
          where: { path: DECLARING_FILE },
        },
      ],
    });
  });

  test('a descriptor whose fields cannot be read fails instead of throwing', () => {
    const hostile = {
      get id(): string {
        throw new Error('id getter');
      },
      nodes: {},
    };
    const result = validate({ extensions: [hostile], state: stateDescriptor() });
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'CONFIG.FIELD_INVALID',
        summary: 'The `composer` section of prisma.config.ts could not be read.',
      }),
    ]);
  });

  test('the validator never throws, whatever it is handed', () => {
    const hostile = [
      Symbol('x'),
      new Proxy({}, { get: () => undefined }),
      Object.create(null),
      new Proxy(
        {},
        {
          get: () => {
            throw new Error('get trap');
          },
        },
      ),
      {
        extensions: new Proxy([], {
          get: () => {
            throw new Error('array trap');
          },
        }),
      },
    ];
    for (const raw of hostile) {
      expect(() => validate(raw)).not.toThrow();
    }
  });

  test('a section the engine reports with no declaring file is refused as missing', () => {
    expect(validate(validSection(), NO_FILE)).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'CONFIG.SECTION_MISSING' }],
    });
  });
});

describe('composerSection.validate() on extensions', () => {
  test('extensions that are not an array fail', () => {
    for (const extensions of [undefined, {}, 'ext-a']) {
      expect(validate({ extensions, state: stateDescriptor() })).toEqual({
        ok: false,
        diagnostics: [
          {
            code: 'CONFIG.FIELD_INVALID',
            severity: 'error',
            summary: '`composer.extensions` must be an array of extension descriptors.',
            nextActions: [
              {
                kind: 'edit-file',
                label:
                  'Set `extensions` to the descriptors your extensions provide, e.g. `extensions: [nodeBuild()]`.',
              },
            ],
            where: { path: DECLARING_FILE },
            meta: { field: 'extensions' },
          },
        ],
      });
    }
  });

  test('an entry that is not an object fails, naming the factory mistake', () => {
    for (const entry of [null, 'ext-a', [], () => extension('ext-a')]) {
      expect(validate({ extensions: [entry], state: stateDescriptor() })).toEqual({
        ok: false,
        diagnostics: [
          {
            code: 'CONFIG.FIELD_INVALID',
            severity: 'error',
            summary: '`composer.extensions[0]` must be an extension descriptor object.',
            nextActions: [
              {
                kind: 'edit-file',
                label:
                  'Put the descriptor an extension factory returns here, e.g. `nodeBuild()`, not the factory itself.',
              },
            ],
            where: { path: DECLARING_FILE },
            meta: { field: 'extensions[0]' },
          },
        ],
      });
    }
  });

  test('an entry without a non-empty string id fails', () => {
    for (const id of [undefined, '', 42]) {
      const entry = { ...extension('ext-a'), id };
      expect(validate({ extensions: [entry], state: stateDescriptor() })).toEqual({
        ok: false,
        diagnostics: [
          {
            code: 'CONFIG.FIELD_INVALID',
            severity: 'error',
            summary:
              '`composer.extensions[0].id` must be a non-empty string (the extension package name).',
            nextActions: [
              {
                kind: 'edit-file',
                label:
                  'Use the descriptor the extension factory returns, unchanged, instead of building one by hand.',
              },
            ],
            where: { path: DECLARING_FILE },
            meta: { field: 'extensions[0].id' },
          },
        ],
      });
    }
  });

  test('an entry without an object nodes registry fails', () => {
    for (const nodes of [undefined, null, 'x']) {
      const entry = { ...extension('ext-a'), nodes };
      expect(validate({ extensions: [entry], state: stateDescriptor() })).toEqual({
        ok: false,
        diagnostics: [
          {
            code: 'CONFIG.FIELD_INVALID',
            severity: 'error',
            summary:
              '`composer.extensions[0].nodes` must be an object (the node-ID → control registry).',
            nextActions: [
              {
                kind: 'edit-file',
                label:
                  'Use the descriptor the extension factory returns, unchanged, instead of building one by hand.',
              },
            ],
            where: { path: DECLARING_FILE },
            meta: { field: 'extensions[0].nodes' },
          },
        ],
      });
    }
  });

  test('an extension listed twice fails', () => {
    const result = validate({
      extensions: [extension('ext-a'), extension('ext-a')],
      state: stateDescriptor(),
    });
    expect(result).toEqual({
      ok: false,
      diagnostics: [
        {
          code: 'CONFIG.EXTENSION_DUPLICATE',
          severity: 'error',
          summary: 'Extension "ext-a" is listed more than once in `composer.extensions`.',
          nextActions: [
            { kind: 'edit-file', label: 'Remove the repeated "ext-a" entry from `extensions`.' },
          ],
          where: { path: DECLARING_FILE },
          meta: { field: 'extensions[1].id' },
        },
      ],
    });
  });
});

describe('composerSection.validate() on state', () => {
  test('a value that is not a state descriptor fails', () => {
    const invalid = [
      undefined,
      'prismaState',
      () => stateDescriptor(),
      { extension: 42, create: () => undefined },
      { extension: 'ext-a' },
      { extension: 'ext-a', create: 'nope' },
    ];
    for (const state of invalid) {
      expect(validate({ extensions: [], state })).toEqual({
        ok: false,
        diagnostics: [
          {
            code: 'CONFIG.FIELD_INVALID',
            severity: 'error',
            summary:
              '`composer.state` must be a state descriptor with a string `extension` and a `create` function.',
            nextActions: [
              {
                kind: 'edit-file',
                label:
                  'Set `state` to the state descriptor an extension provides, e.g. `state: prismaState()`.',
              },
            ],
            where: { path: DECLARING_FILE },
            meta: { field: 'state' },
          },
        ],
      });
    }
  });
});

describe('composerSection.validate() collects findings', () => {
  test('reports every bad field in one run', () => {
    const result = validate({ extensions: [null, { id: 'x' }], state: undefined, extra: 1 });
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.meta?.['field'])).toEqual([
      'extra',
      'extensions[0]',
      'extensions[1].nodes',
      'state',
    ]);
  });
});

describe('composerSection.merge', () => {
  /**
   * The engine folds a section over the chain of config files, nearest last.
   * Taking the nearer file's section whole means the section always comes
   * from exactly one file, the one the command's generated stack imports.
   */
  test('takes the nearer file’s section whole and drops the farther one', () => {
    const parent = validSection();
    const child = { extensions: [extension('ext-c')] };
    expect(composerSection.merge?.(parent, child)).toBe(child);
  });
});

test('the section is named `composer`', () => {
  expect(composerSection.name).toBe('composer');
});

describe('composerSection.validate() on a retired config file', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(): string {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'composer-section-')));
    dirs.push(dir);
    return dir;
  }

  test('an old config file beside the declaring file is refused, naming it', () => {
    for (const name of [
      'prisma-composer.config.ts',
      'prisma-composer.config.mts',
      'prisma-composer.config.mjs',
      'prisma-composer.config.js',
    ]) {
      const dir = tempDir();
      const retired = path.join(dir, name);
      fs.writeFileSync(retired, 'export default {};\n');

      expect(validate(validSection(), provenance(path.join(dir, 'prisma.config.ts')))).toEqual({
        ok: false,
        diagnostics: [
          {
            code: 'CONFIG.FILE_RETIRED',
            severity: 'error',
            summary: `${retired} is no longer read.`,
            why: 'Composer reads its configuration only from the `composer` section of prisma.config.ts.',
            nextActions: [
              {
                kind: 'edit-file',
                label: `${SECTION_FIX} If the project has a prisma-composer.config.ts, move its extensions and state into that section and delete the file.`,
              },
            ],
            where: { path: retired },
          },
        ],
      });
    }
  });

  test('an old config file in any other directory is not checked', () => {
    const root = tempDir();
    const app = path.join(root, 'app');
    fs.mkdirSync(app);
    fs.writeFileSync(path.join(app, 'prisma-composer.config.ts'), 'export default {};\n');

    const result = validate(validSection(), provenance(path.join(root, 'prisma.config.ts')));
    expect(result.ok).toBe(true);
  });

  test('the old file is reported first, together with every field finding', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'prisma-composer.config.ts'), 'export default {};\n');

    const result = validate(
      { extensions: [], state: undefined },
      provenance(path.join(dir, 'prisma.config.ts')),
    );

    expect(result.diagnostics.map((d) => d.code)).toEqual([
      'CONFIG.FILE_RETIRED',
      'CONFIG.FIELD_INVALID',
    ]);
  });

  test('a symlinked config file is checked beside the file it links to', () => {
    const real = tempDir();
    const linked = tempDir();
    fs.writeFileSync(path.join(real, 'prisma.config.ts'), 'export default {};\n');
    fs.writeFileSync(path.join(real, 'prisma-composer.config.ts'), 'export default {};\n');
    fs.symlinkSync(path.join(real, 'prisma.config.ts'), path.join(linked, 'prisma.config.ts'));

    const result = validate(validSection(), provenance(path.join(linked, 'prisma.config.ts')));

    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'CONFIG.FILE_RETIRED',
        where: { path: path.join(real, 'prisma-composer.config.ts') },
      }),
    ]);
  });
});
