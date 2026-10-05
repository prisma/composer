/**
 * A structured error a local target's `emulators` hook throws reaches the
 * user of `dev` unchanged: the same code, why and fix, in the run's error
 * envelope. The hook throws what `@internal/dev-emulators` throws for a
 * relative PRISMA_COMPOSER_EMULATORS_DIR; this package cannot import it.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServiceNode } from '@internal/core';
import type { ContainerInstance, PrismaAppConfig } from '@internal/core/config';
import type { LocalTargetDescriptor } from '@internal/core/local-target';
import { CliStructuredError } from '@internal/foundation/errors';
import { createTestCli } from '@prisma/cli-engine/testing';
import * as Layer from 'effect/Layer';
import { devWithDeps } from '../../operations/dev.ts';
import { createComposerFamily, realOperations } from '../family.ts';

const coreIndex = path.resolve(import.meta.dir, '../../../../../1-core/core/src/exports/index.ts');

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeAppDir(): { dir: string; entryPath: string } {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'composer-dev-emulators-dir-')),
  );
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture-app' }));
  fs.writeFileSync(path.join(dir, 'prisma.config.ts'), 'export default { composer: {} };\n');
  const entryPath = path.join(dir, 'service.ts');
  fs.writeFileSync(
    entryPath,
    [
      `import { module, service } from ${JSON.stringify(coreIndex)};`,
      "export default module('fixture-app', {}, ({ provision }) => {",
      '  provision(',
      '    service({',
      "      name: 'app',",
      "      extension: 'fixture-extension',",
      "      type: 'fixture/compute',",
      '      inputs: {},',
      '      params: {},',
      "      build: { extension: 'fixture-build', type: 'node', module: import.meta.url, entry: 'dist/server.js' },",
      '    }),',
      "    { id: 'app' },",
      '  );',
      '  return {};',
      '});',
      '',
    ].join('\n'),
  );
  return { dir, entryPath };
}

const unused = () => {
  throw new Error('not reached before the emulators phase');
};

function localContainer(): ContainerInstance {
  return { input: { appName: 'fixture-app', stage: undefined }, serialize: () => 'x' };
}

const emulatorsDirInvalid = new CliStructuredError(
  'DEV.EMULATORS_DIR_INVALID',
  'PRISMA_COMPOSER_EMULATORS_DIR must be an absolute path; got "emulators".',
  {
    why: 'A relative path would name a different directory in each working directory.',
    fix: 'Set PRISMA_COMPOSER_EMULATORS_DIR to an absolute path (`~` is not expanded).',
    meta: { variable: 'PRISMA_COMPOSER_EMULATORS_DIR', value: 'emulators' },
  },
);

function configWhoseEmulatorsThrow(): PrismaAppConfig {
  const descriptor: LocalTargetDescriptor = {
    providers: () => Layer.empty,
    container: {
      ensure: () => Promise.resolve(localContainer()),
      locate: () => Promise.resolve(undefined),
      remove: () => Promise.resolve(),
      deserialize: () => localContainer(),
    },
    emulators: () => Promise.reject(emulatorsDirInvalid),
    attach: unused,
  };
  return {
    extensions: [
      {
        id: 'fixture-extension',
        nodes: {
          'fixture/compute': {
            kind: 'service',
            provision: unused,
            serialize: unused,
            package: unused,
            deploy: unused,
          },
        },
        localTarget: () => Promise.resolve(descriptor),
      },
      { id: 'fixture-build', nodes: { node: { kind: 'build', assemble: unused } } },
    ],
    state: { extension: 'fixture-extension', create: unused },
  };
}

const fakeAssembler = async (node: ServiceNode) => ({
  dir: path.join(path.dirname(fileURLToPath(node.build.module)), 'dist', 'bundle'),
  entry: 'server.js',
});

describe.skipIf(process.platform === 'win32')(
  'dev, when the emulators refuse their directory',
  () => {
    test('the run fails with the emulators’ own structured error', async () => {
      const app = makeAppDir();
      const family = createComposerFamily({
        operations: {
          ...realOperations,
          dev: (input, deps) => devWithDeps(input, { ...deps, runAssembler: fakeAssembler }),
        },
      });
      const cli = createTestCli({
        commandFamilies: [family],
        commands: { ...family.commands },
        config: { composer: configWhoseEmulatorsThrow() },
      });

      const result = await cli.run(['dev', app.entryPath, '--json'], { cwd: app.dir });

      expect(result.exitCode).toBe(2);
      expect(result.json.at(-1)).toMatchObject({
        kind: 'result',
        envelope: {
          ok: false,
          error: {
            code: 'DEV.EMULATORS_DIR_INVALID',
            summary: 'PRISMA_COMPOSER_EMULATORS_DIR must be an absolute path; got "emulators".',
            why: emulatorsDirInvalid.why,
            meta: { variable: 'PRISMA_COMPOSER_EMULATORS_DIR', value: 'emulators' },
            nextActions: [{ kind: 'user-choice', label: emulatorsDirInvalid.fix }],
          },
        },
      });
    }, 30_000);
  },
);
