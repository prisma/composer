/**
 * The family the `prisma` host mounts, and its `composer` section driven
 * through the engine's own config machinery on a probe command, the wiring
 * `deploy` and `dev` depend on for `ctx.config`.
 */
import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import { defineCommand, defineCommandFamily } from '@prisma/cli-engine';
import { notOk, ok } from '@prisma/cli-engine/protocol';
import { createTestCli } from '@prisma/cli-engine/testing';
import { createComposerFamily, realOperations } from '../family.ts';
import { composerSection } from '../section.ts';

describe('createComposerFamily()', () => {
  test('the family carries the composer section token', () => {
    expect(createComposerFamily().configSection).toBe(composerSection);
  });

  test('the family mounts deploy and dev only — destroy and log are retired', () => {
    expect(Object.keys(createComposerFamily().commands).sort()).toEqual(['deploy', 'dev']);
  });

  test('the family ships no redirects for the retired spellings', () => {
    expect(createComposerFamily().redirects).toEqual([]);
  });

  test('the operations seam defaults to the real control operations', () => {
    expect(realOperations.deploy).toBeInstanceOf(Function);
    expect(realOperations.dev).toBeInstanceOf(Function);
  });

  test('a host may substitute the operations', () => {
    const doubles = { ...realOperations, deploy: async () => notOk(new Error('unused')) };
    expect(() =>
      createComposerFamily({
        operations: doubles as unknown as typeof realOperations,
      }),
    ).not.toThrow();
  });
});

/**
 * The section token, driven through the engine's own config machinery on a
 * probe command. This is the wiring the commands depend on: without it, a
 * command declaring `needs.config` would receive nothing.
 */
const probe = defineCommand({
  help: { summary: 'Report the validated composer section.' },
  needs: { config: composerSection },
  handler: async (_args, ctx) =>
    ok(
      ctx.present(
        { data: ctx.config },
        {
          human: () => [],
          stdout: () => [],
          json: () => ctx.config,
          next: () => [],
        },
      ),
    ),
});

function probeCli(sections: Record<string, unknown>) {
  return createTestCli({
    commandFamilies: [defineCommandFamily({ configSection: composerSection, commands: { probe } })],
    commands: { probe },
    config: sections,
  });
}

function composerConfig() {
  return {
    extensions: [{ id: 'ext-a', nodes: {}, providers: () => 'layer' }],
    state: { extension: 'ext-a', create: () => 'state' },
  };
}

/** The terminal result event of a `--json` run, which carries the error and its diagnostics. */
function resultEvent(result: { json: readonly unknown[] }) {
  return result.json.at(-1);
}

describe('the composer section through the engine', () => {
  test('a valid section reaches the handler as the config file’s own descriptors', async () => {
    const composer = composerConfig();
    const result = await probeCli({ composer }).run(['probe', '--json']);
    expect(result.exitCode).toBe(0);
    expect(result.presented?.data).toEqual({
      value: composer,
      file: path.resolve(path.sep, 'prisma.config.ts'),
    });
    const data = result.presented?.data as { value: typeof composer };
    expect(data.value.extensions[0]).toBe(composer.extensions[0]);
    expect(data.value.state).toBe(composer.state);
  });

  /**
   * The engine calls the validator with `undefined` and an empty provenance
   * when no loaded file declares the section, so Composer's diagnostic rides
   * under the engine's own "section is missing" headline.
   */
  test('no section fails before the handler, with the section to write', async () => {
    const result = await probeCli({}).run(['probe', '--json']);
    expect(result.exitCode).not.toBe(0);
    expect(result.presented).toBeUndefined();
    expect(resultEvent(result)).toMatchObject({
      kind: 'result',
      envelope: {
        ok: false,
        error: {
          code: 'CLI.CONFIG_SECTION_INVALID',
          summary: "The 'composer' section is missing: no loaded config file declares it.",
        },
        diagnostics: [
          {
            code: 'CONFIG.SECTION_MISSING',
            severity: 'error',
            summary: 'No loaded prisma.config.ts declares a `composer` section.',
          },
        ],
      },
    });
  });

  test('a configPath section fails before the handler, naming the retired field', async () => {
    const result = await probeCli({
      composer: { configPath: './prisma-composer.config.ts' },
    }).run(['probe', '--json']);
    expect(result.exitCode).not.toBe(0);
    expect(result.presented).toBeUndefined();
    expect(resultEvent(result)).toMatchObject({
      kind: 'result',
      envelope: {
        ok: false,
        error: { code: 'CLI.CONFIG_SECTION_INVALID' },
        diagnostics: [
          {
            code: 'CONFIG.FIELD_RETIRED',
            severity: 'error',
            where: { path: path.resolve(path.sep, 'prisma.config.ts') },
            meta: { field: 'configPath' },
          },
        ],
      },
    });
  });

  /**
   * prisma.config.ts files form a chain, discovered from cwd up to the repo
   * root. The engine's default would merge the section per key, so a nearer
   * file's `extensions` could combine with a farther file's `state`. The
   * section takes the nearest declaring file's section whole instead, so the
   * farther `state` must not appear, and the missing one is reported.
   */
  test('the nearest declaring file’s section wins whole over a farther one', async () => {
    const repo = path.resolve(path.sep, 'repo');
    const appDir = path.join(repo, 'apps', 'shop');
    const root = composerConfig();
    const nearer = { extensions: [{ id: 'ext-b', nodes: {} }] };
    const cli = createTestCli({
      commandFamilies: [
        defineCommandFamily({ configSection: composerSection, commands: { probe } }),
      ],
      commands: { probe },
      loadConfig: () =>
        Promise.resolve({
          files: [
            { path: path.join(appDir, 'prisma.config.ts'), sections: { composer: nearer } },
            { path: path.join(repo, 'prisma.config.ts'), sections: { composer: root } },
          ],
          diagnostics: [],
        }),
    });

    const result = await cli.run(['probe', '--json'], { cwd: appDir });

    expect(result.exitCode).not.toBe(0);
    expect(resultEvent(result)).toMatchObject({
      kind: 'result',
      envelope: {
        ok: false,
        diagnostics: [
          {
            code: 'CONFIG.FIELD_INVALID',
            where: { path: path.join(appDir, 'prisma.config.ts') },
            meta: { field: 'state' },
          },
        ],
      },
    });
  });

  test('a section declared only at the repo root reaches a command run below it', async () => {
    const repo = path.resolve(path.sep, 'repo');
    const appDir = path.join(repo, 'apps', 'shop');
    const root = composerConfig();
    const cli = createTestCli({
      commandFamilies: [
        defineCommandFamily({ configSection: composerSection, commands: { probe } }),
      ],
      commands: { probe },
      loadConfig: () =>
        Promise.resolve({
          files: [
            { path: path.join(appDir, 'prisma.config.ts'), sections: {} },
            { path: path.join(repo, 'prisma.config.ts'), sections: { composer: root } },
          ],
          diagnostics: [],
        }),
    });

    const result = await cli.run(['probe', '--json'], { cwd: appDir });

    expect(result.exitCode).toBe(0);
    expect(result.presented?.data).toEqual({
      value: root,
      file: path.join(repo, 'prisma.config.ts'),
    });
  });

  test('a truly unknown section still fails the run', async () => {
    const result = await probeCli({ composer: composerConfig(), tpyo: {} }).run(['probe']);
    expect(result.exitCode).not.toBe(0);
    expect(result.presented).toBeUndefined();
  });
});
