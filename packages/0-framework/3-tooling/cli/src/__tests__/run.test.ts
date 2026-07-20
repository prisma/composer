/**
 * Drives main.ts's run() end to end with fakes at the module seams the CLI
 * already exposes (RunDeps): a fake config (no c12 evaluation), a fake
 * assembler (no real wrapper build), and a fake alchemy runner (no real
 * process). Container lifecycle is stubbed via the fake config's own
 * extension `container` descriptor — run() no longer has a dedicated
 * container seam; every extension supplies its own. The entry module, the
 * `prisma-composer.config.ts` file (discovery is real — the generated stack
 * file imports the real path), and the generated stack file are all real —
 * written to a temp dir.
 *
 * `.prisma-composer/` lands in the process's own cwd (ADR-0004's rewrite — tool
 * state lives where you run the tool), so each test chdir's into the fixture
 * app dir for the duration of run(), the same way a real invocation's cwd is
 * wherever the app's package script runs from.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServiceNode } from '@internal/core';
import type {
  ContainerDescriptor,
  ContainerInstance,
  ExtensionDescriptor,
  LocateContainerInput,
  PrismaAppConfig,
} from '@internal/core/config';
import { containerEnvVarName } from '@internal/core/config';
import { CliError } from '../cli-error.ts';
import { run } from '../main.ts';
import type { RunAlchemyInput } from '../run-alchemy.ts';

interface FakeContainer extends ContainerInstance {
  readonly containerRef: string;
  readonly containerScope: string | undefined;
}

function makeFakeContainer(input: LocateContainerInput): FakeContainer {
  const containerScope = input.stage !== undefined ? `branch-${input.stage}` : undefined;
  return {
    input,
    containerRef: 'proj-fake',
    containerScope,
    serialize: () => JSON.stringify({ input, containerRef: 'proj-fake', containerScope }),
  };
}

interface ContainerCall {
  readonly op: 'ensure' | 'locate' | 'remove';
  readonly input: LocateContainerInput;
}

/** A fake `container` descriptor — no real Management API calls, no env requirements. */
function fakeContainerDescriptor(
  opts: {
    readonly calls?: ContainerCall[];
    readonly notFound?: boolean;
    readonly onRemove?: (instance: FakeContainer) => void | Promise<void>;
  } = {},
): ContainerDescriptor {
  const calls = opts.calls ?? [];
  return {
    ensure: async (input) => {
      calls.push({ op: 'ensure', input });
      return makeFakeContainer(input);
    },
    locate: async (input) => {
      calls.push({ op: 'locate', input });
      if (opts.notFound === true) return undefined;
      return makeFakeContainer(input);
    },
    remove: async (instance) => {
      calls.push({ op: 'remove', input: instance.input });
      await opts.onRemove?.(instance as FakeContainer);
    },
    deserialize: (serialized) => {
      const parsed = JSON.parse(serialized) as { input: LocateContainerInput };
      return makeFakeContainer(parsed.input);
    },
  };
}

const CONTAINER_VAR = containerEnvVarName('fixture-extension');

const coreIndex = path.resolve(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  '1-core',
  'core',
  'src',
  'exports',
  'index.ts',
);

const tmpDirs: string[] = [];
const originalCwd = process.cwd();

/**
 * The fake config: registries covering the fixture's service + build
 * (extension, type) keys. The descriptor bodies are never invoked here — run()
 * only validates coverage; the service SPI runs inside the (faked) alchemy
 * stack, and the build assemble is substituted by the runAssembler seam.
 */
function fakeConfig(
  hooks: Partial<Pick<ExtensionDescriptor, 'teardown' | 'preflight'>> = {},
  containerOpts: Parameters<typeof fakeContainerDescriptor>[0] = {},
): PrismaAppConfig {
  const unused = () => {
    throw new Error('descriptor body must not run inside run() — only coverage is checked');
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
        container: fakeContainerDescriptor(containerOpts),
        ...(hooks.teardown !== undefined ? { teardown: hooks.teardown } : {}),
        ...(hooks.preflight !== undefined ? { preflight: hooks.preflight } : {}),
      },
      { id: 'fixture-build', nodes: { node: { kind: 'build', assemble: unused } } },
    ],
    state: {
      extension: 'fixture-extension',
      create: unused,
    },
  };
}

/**
 * A real app package in a temp dir: package.json, a `prisma-composer.config.ts`
 * (discovery walks up to it; its CONTENT is never evaluated — RunDeps.config
 * substitutes for c12), and an entry module whose default export is a genuine
 * service node (importing core by absolute path — the temp dir has no other
 * node_modules).
 */
function makeAppDir(
  name = 'fixture-app',
  opts: { config?: boolean } = {},
): {
  dir: string;
  entryPath: string;
} {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-composer-cli-run-')));
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture-app' }));
  if (opts.config !== false) {
    fs.writeFileSync(
      path.join(dir, 'prisma-composer.config.ts'),
      '// fixture config — discovery target only; tests inject RunDeps.config instead of evaluating this\nexport default {};\n',
    );
  }
  const entryPath = path.join(dir, 'service.ts');
  fs.writeFileSync(
    entryPath,
    [
      `import { module, service } from ${JSON.stringify(coreIndex)};`,
      '',
      `export default module(${JSON.stringify(name)}, {}, ({ provision }) => {`,
      '  provision(',
      '    service({',
      `      name: ${JSON.stringify(name)},`,
      "      extension: 'fixture-extension',",
      "      type: 'fixture/compute',",
      '      inputs: {},',
      '      params: {},',
      "      build: { extension: 'fixture-build', type: 'node', module: import.meta.url, entry: 'dist/server.js' },",
      '    }),',
      `    { id: ${JSON.stringify(name)} },`,
      '  );',
      '  return {};',
      '});',
      '',
    ].join('\n'),
  );
  return { dir, entryPath };
}

const fakeAssembler = async (node: ServiceNode) => ({
  dir: path.join(path.dirname(fileURLToPath(node.build.module)), 'dist', 'bundle'),
  entry: 'server.js',
});

afterEach(() => {
  process.chdir(originalCwd);
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('run() — the full pipeline over fakes', () => {
  test('a successful deploy generates the stack file and invokes alchemy with the resolved container env', async () => {
    const app = makeAppDir('hello-run');
    process.chdir(app.dir);
    const calls: RunAlchemyInput[] = [];

    const status = await run(['deploy', app.entryPath, '--stage', 'ci-7'], {
      config: fakeConfig(),
      runAssembler: fakeAssembler,
      alchemy: (input) => {
        calls.push(input);
        return 0;
      },
    });

    expect(status).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: 'deploy',
      stackFileRelativePath: path.join('.prisma-composer', 'alchemy.run.ts'),
      cwd: app.dir,
      stage: 'ci-7',
    });
    const serialized = calls[0]?.containerEnv[CONTAINER_VAR];
    expect(serialized).toBeDefined();
    expect(JSON.parse(serialized ?? '')).toMatchObject({
      input: { appName: 'hello-run', stage: 'ci-7' },
      containerRef: 'proj-fake',
      containerScope: 'branch-ci-7',
    });

    const stackPath = path.join(app.dir, '.prisma-composer', 'alchemy.run.ts');
    const content = fs.readFileSync(stackPath, 'utf8');
    expect(content).toContain('name: "hello-run"');
    expect(content).toContain('import config from "../prisma-composer.config.ts";');
    expect(content).toContain('import app from "../service.ts";');
    expect(content).toContain('lower(app, config, {');
    expect(content).toContain(
      `"hello-run": { dir: ${JSON.stringify(path.join(app.dir, 'dist', 'bundle'))}, entry: "server.js" }`,
    );
  });

  test('the container descriptor is called with the resolved appName + stage, and the default stage has no containerScope', async () => {
    const app = makeAppDir('hello-default-stage');
    process.chdir(app.dir);
    const containerCalls: ContainerCall[] = [];
    const alchemyCalls: RunAlchemyInput[] = [];

    const status = await run(['deploy', app.entryPath], {
      config: fakeConfig({}, { calls: containerCalls }),
      runAssembler: fakeAssembler,
      alchemy: (input) => {
        alchemyCalls.push(input);
        return 0;
      },
    });

    expect(status).toBe(0);
    expect(containerCalls).toEqual([
      { op: 'ensure', input: { appName: 'hello-default-stage', stage: undefined } },
    ]);
    expect(alchemyCalls).toHaveLength(1);
    const serialized = JSON.parse(alchemyCalls[0]?.containerEnv[CONTAINER_VAR] ?? '{}');
    expect(serialized.containerRef).toBe('proj-fake');
    expect(serialized.containerScope).toBeUndefined();
  });

  test('a missing prisma-composer.config.ts is a CliError naming the filename and the required export', async () => {
    const app = makeAppDir('no-config', { config: false });
    process.chdir(app.dir);

    const error: unknown = await run(['deploy', app.entryPath], {
      runAssembler: fakeAssembler,
      alchemy: () => 0,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CliError);
    const message = (error as CliError).message;
    expect(message).toContain('prisma-composer.config.ts');
    expect(message).toContain('defineConfig');
  });

  test("a node whose extension isn't configured is a CliError naming the extension and the config fix, before assembly", async () => {
    const app = makeAppDir('uncovered');
    process.chdir(app.dir);
    const config = fakeConfig();
    const assemblerCalls: string[] = [];

    const error: unknown = await run(['deploy', app.entryPath], {
      config: {
        ...config,
        extensions: config.extensions.filter((e) => e.id !== 'fixture-extension'),
      },
      runAssembler: async (node) => {
        assemblerCalls.push(node.name);
        return fakeAssembler(node);
      },
      alchemy: () => 0,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CliError);
    const message = (error as CliError).message;
    expect(message).toContain('fixture-extension');
    expect(message).toContain('prisma-composer.config.ts');
    expect(assemblerCalls).toEqual([]);
  });

  test("a build descriptor whose extension isn't configured is a CliError naming it", async () => {
    const app = makeAppDir('uncovered-build');
    process.chdir(app.dir);
    const config = fakeConfig();

    const error: unknown = await run(['deploy', app.entryPath], {
      config: { ...config, extensions: config.extensions.filter((e) => e.id !== 'fixture-build') },
      runAssembler: fakeAssembler,
      alchemy: () => 0,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toContain('fixture-build');
  });

  test('--name with an empty value is a CliError naming the fix', async () => {
    const app = makeAppDir();
    process.chdir(app.dir);

    await expect(
      run(['deploy', app.entryPath, '--name', ''], {
        config: fakeConfig(),
        runAssembler: fakeAssembler,
        alchemy: () => 0,
      }),
    ).rejects.toThrow(CliError);
    await expect(
      run(['deploy', app.entryPath, '--name', ''], {
        config: fakeConfig(),
        runAssembler: fakeAssembler,
        alchemy: () => 0,
      }),
    ).rejects.toThrow(/name it at authoring, or pass --name/);
  });

  test('invokes each extension preflight with the resolved container, before alchemy runs', async () => {
    const app = makeAppDir('hello-preflight');
    process.chdir(app.dir);
    const preflightCalls: Array<{
      containerRef: string;
      containerScope: string | undefined;
      stage: string | undefined;
      nodeCount: number;
    }> = [];

    const status = await run(['deploy', app.entryPath, '--stage', 'ci-7'], {
      config: fakeConfig({
        preflight: async (input) => {
          const container = input.container as FakeContainer | undefined;
          preflightCalls.push({
            containerRef: container?.containerRef ?? '',
            containerScope: container?.containerScope,
            stage: input.stage,
            nodeCount: input.graph.nodes.length,
          });
        },
      }),
      runAssembler: fakeAssembler,
      alchemy: () => 0,
    });

    expect(status).toBe(0);
    expect(preflightCalls).toHaveLength(1);
    expect(preflightCalls[0]).toMatchObject({
      containerRef: 'proj-fake',
      containerScope: 'branch-ci-7',
      stage: 'ci-7',
    });
    expect(preflightCalls[0]!.nodeCount).toBeGreaterThan(0);
  });

  test('a preflight failure aborts as a CliError before any stack file is written or alchemy runs', async () => {
    const app = makeAppDir('hello-preflight-fail');
    process.chdir(app.dir);
    let alchemyRan = false;

    const error: unknown = await run(['deploy', app.entryPath, '--stage', 'ci-7'], {
      config: fakeConfig({
        preflight: async () => {
          throw new Error('SECRET_X is not provisioned');
        },
      }),
      runAssembler: fakeAssembler,
      alchemy: () => {
        alchemyRan = true;
        return 0;
      },
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toContain('SECRET_X is not provisioned');
    expect(alchemyRan).toBe(false);
    // Preflight (step 7.5) runs before writeStackFile (step 8) — nothing side-effected.
    expect(fs.existsSync(path.join(app.dir, '.prisma-composer', 'alchemy.run.ts'))).toBe(false);
  });

  test('an alchemy failure propagates the nonzero exit and prints the generated file path', async () => {
    const app = makeAppDir();
    process.chdir(app.dir);
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const status = await run(['deploy', app.entryPath], {
        config: fakeConfig(),
        runAssembler: fakeAssembler,
        alchemy: () => 42,
      });

      expect(status).toBe(42);
      const stackPath = path.join(app.dir, '.prisma-composer', 'alchemy.run.ts');
      const printed = errorSpy.mock.calls.map((args) => args.join(' ')).join('\n');
      expect(printed).toContain(stackPath);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('a destroy blocked by missing built output explains that destroy needs the build too', async () => {
    const app = makeAppDir();
    process.chdir(app.dir);
    fs.mkdirSync(path.join(app.dir, '.alchemy'), { recursive: true });
    fs.writeFileSync(path.join(app.dir, '.alchemy', 'state.json'), '{}');
    const failingAssembler = async () => {
      throw new Error('no built entry at /some/dist/server.js — run this app’s own build first');
    };

    const error: unknown = await run(['destroy', app.entryPath, '--production'], {
      config: fakeConfig(),
      runAssembler: failingAssembler,
      alchemy: () => 0,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CliError);
    const message = (error as CliError).message;
    expect(message).toContain('no built entry at');
    expect(message).toContain('destroy evaluates the same stack program as deploy');
    expect(message).toContain('Run the build, then retry the destroy.');
  });

  test('the same assembly failure on deploy keeps its original message, without the destroy note', async () => {
    const app = makeAppDir();
    process.chdir(app.dir);
    const failingAssembler = async () => {
      throw new Error('no built entry at /some/dist/server.js');
    };

    const error: unknown = await run(['deploy', app.entryPath], {
      config: fakeConfig(),
      runAssembler: failingAssembler,
      alchemy: () => 0,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('no built entry at');
    expect(message).not.toContain('destroy evaluates');
  });

  describe('destroy with no local .alchemy state (R2a-review guardrail)', () => {
    test('warns (not fails) before running alchemy when .alchemy is missing', async () => {
      const app = makeAppDir();
      process.chdir(app.dir);
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const status = await run(['destroy', app.entryPath, '--production'], {
          config: fakeConfig(),
          runAssembler: fakeAssembler,
          alchemy: () => 0,
        });

        expect(status).toBe(0);
        const printed = warnSpy.mock.calls.map((args) => args.join(' ')).join('\n');
        expect(printed).toContain(`No prior deploy state under ${app.dir}`);
        expect(printed).toContain(
          'if you deployed from a different directory, run destroy from there',
        );
      } finally {
        warnSpy.mockRestore();
      }
    });

    test('warns when .alchemy exists but is empty', async () => {
      const app = makeAppDir();
      process.chdir(app.dir);
      fs.mkdirSync(path.join(app.dir, '.alchemy'), { recursive: true });
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await run(['destroy', app.entryPath, '--production'], {
          config: fakeConfig(),
          runAssembler: fakeAssembler,
          alchemy: () => 0,
        });

        const printed = warnSpy.mock.calls.map((args) => args.join(' ')).join('\n');
        expect(printed).toContain('No prior deploy state under');
      } finally {
        warnSpy.mockRestore();
      }
    });

    test('does not warn when .alchemy has state', async () => {
      const app = makeAppDir();
      process.chdir(app.dir);
      fs.mkdirSync(path.join(app.dir, '.alchemy'), { recursive: true });
      fs.writeFileSync(path.join(app.dir, '.alchemy', 'state.json'), '{}');
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await run(['destroy', app.entryPath, '--production'], {
          config: fakeConfig(),
          runAssembler: fakeAssembler,
          alchemy: () => 0,
        });

        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });

    test('a deploy never checks .alchemy state — no warning', async () => {
      const app = makeAppDir();
      process.chdir(app.dir);
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await run(['deploy', app.entryPath], {
          config: fakeConfig(),
          runAssembler: fakeAssembler,
          alchemy: () => 0,
        });

        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  describe('destroy target selection (--stage / --production, spec §10)', () => {
    test('a bare destroy with no --stage and no --production is a CliError naming the required target', async () => {
      await expect(run(['destroy', 'src/service.ts'])).rejects.toThrow(CliError);
      await expect(run(['destroy', 'src/service.ts'])).rejects.toThrow(
        /requires an explicit target/,
      );
    });

    test('destroy --stage x --production together is a CliError (mutually exclusive)', async () => {
      await expect(
        run(['destroy', 'src/service.ts', '--stage', 'staging', '--production']),
      ).rejects.toThrow(CliError);
      await expect(
        run(['destroy', 'src/service.ts', '--stage', 'staging', '--production']),
      ).rejects.toThrow(/not both/);
    });

    test('deploy --production is a CliError (--production is destroy-only)', async () => {
      await expect(run(['deploy', 'src/service.ts', '--production'])).rejects.toThrow(CliError);
      await expect(run(['deploy', 'src/service.ts', '--production'])).rejects.toThrow(
        /only valid with `destroy`/,
      );
    });

    test('an invalid --stage is a CliError from validateStageName, before any container call', async () => {
      const app = makeAppDir();
      process.chdir(app.dir);
      const containerCalls: ContainerCall[] = [];

      const error: unknown = await run(['deploy', app.entryPath, '--stage', 'foo bar'], {
        config: fakeConfig({}, { calls: containerCalls }),
        runAssembler: fakeAssembler,
        alchemy: () => 0,
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).message).toContain('Invalid --stage');
      expect(containerCalls).toEqual([]);
    });

    test('destroy --production resolves the project-level environment (no containerScope) via the container descriptor', async () => {
      const app = makeAppDir();
      process.chdir(app.dir);
      fs.mkdirSync(path.join(app.dir, '.alchemy'), { recursive: true });
      fs.writeFileSync(path.join(app.dir, '.alchemy', 'state.json'), '{}');
      const containerCalls: ContainerCall[] = [];
      const alchemyCalls: RunAlchemyInput[] = [];

      const status = await run(['destroy', app.entryPath, '--production'], {
        config: fakeConfig({}, { calls: containerCalls }),
        runAssembler: fakeAssembler,
        alchemy: (input) => {
          alchemyCalls.push(input);
          return 0;
        },
      });

      expect(status).toBe(0);
      // locate resolves the container; a successful destroy then removes it —
      // both against the same {appName, stage: undefined} input.
      expect(containerCalls.map((c) => c.op)).toEqual(['locate', 'remove']);
      expect(containerCalls[0]?.input).toEqual({ appName: 'fixture-app', stage: undefined });
      expect(alchemyCalls).toHaveLength(1);
      expect(alchemyCalls[0]?.stage).toBeUndefined();
      const serialized = JSON.parse(alchemyCalls[0]?.containerEnv[CONTAINER_VAR] ?? '{}');
      expect(serialized.containerScope).toBeUndefined();
    });

    test('destroy --stage staging resolves the branch path via the container descriptor', async () => {
      const app = makeAppDir();
      process.chdir(app.dir);
      fs.mkdirSync(path.join(app.dir, '.alchemy'), { recursive: true });
      fs.writeFileSync(path.join(app.dir, '.alchemy', 'state.json'), '{}');
      const containerCalls: ContainerCall[] = [];
      const alchemyCalls: RunAlchemyInput[] = [];

      const status = await run(['destroy', app.entryPath, '--stage', 'staging'], {
        config: fakeConfig({}, { calls: containerCalls }),
        runAssembler: fakeAssembler,
        alchemy: (input) => {
          alchemyCalls.push(input);
          return 0;
        },
      });

      expect(status).toBe(0);
      expect(containerCalls[0]).toEqual({
        op: 'locate',
        input: { appName: 'fixture-app', stage: 'staging' },
      });
      expect(alchemyCalls[0]?.stage).toBe('staging');
      const serialized = JSON.parse(alchemyCalls[0]?.containerEnv[CONTAINER_VAR] ?? '{}');
      expect(serialized.containerScope).toBe('branch-staging');
    });

    test('destroy against nothing deployed is a CliError naming the app and stage, from `locate` returning undefined', async () => {
      const app = makeAppDir();
      process.chdir(app.dir);

      const error: unknown = await run(['destroy', app.entryPath, '--stage', 'staging'], {
        config: fakeConfig({}, { notFound: true }),
        runAssembler: fakeAssembler,
        alchemy: () => 0,
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).message).toBe(
        'Nothing deployed for fixture-app/staging — deploy it first.',
      );
    });

    test('destroy against nothing deployed for the default stage names no stage suffix', async () => {
      const app = makeAppDir();
      process.chdir(app.dir);

      const error: unknown = await run(['destroy', app.entryPath, '--production'], {
        config: fakeConfig({}, { notFound: true }),
        runAssembler: fakeAssembler,
        alchemy: () => 0,
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).message).toBe(
        'Nothing deployed for fixture-app — deploy it first.',
      );
    });
  });

  describe('container removal after destroy (spec §10)', () => {
    test('destroy --stage staging, on a successful alchemy destroy, removes the resolved container after teardown', async () => {
      const app = makeAppDir();
      process.chdir(app.dir);
      const order: string[] = [];
      const containerCalls: ContainerCall[] = [];

      const status = await run(['destroy', app.entryPath, '--stage', 'staging'], {
        config: fakeConfig(
          { teardown: async () => void order.push('teardown') },
          {
            calls: containerCalls,
            onRemove: () => void order.push('remove'),
          },
        ),
        runAssembler: fakeAssembler,
        alchemy: () => {
          order.push('alchemy');
          return 0;
        },
      });

      expect(status).toBe(0);
      expect(order).toEqual(['alchemy', 'teardown', 'remove']);
      expect(containerCalls.map((c) => c.op)).toEqual(['locate', 'remove']);
    });

    test('destroy --production removes the resolved container (its own Project)', async () => {
      const app = makeAppDir();
      process.chdir(app.dir);
      const containerCalls: ContainerCall[] = [];

      const status = await run(['destroy', app.entryPath, '--production'], {
        config: fakeConfig({}, { calls: containerCalls }),
        runAssembler: fakeAssembler,
        alchemy: () => 0,
      });

      expect(status).toBe(0);
      expect(containerCalls.map((c) => c.op)).toEqual(['locate', 'remove']);
    });

    test('a FAILED alchemy destroy runs no removal', async () => {
      const app = makeAppDir();
      process.chdir(app.dir);
      const containerCalls: ContainerCall[] = [];

      const status = await run(['destroy', app.entryPath, '--stage', 'staging'], {
        config: fakeConfig({}, { calls: containerCalls }),
        runAssembler: fakeAssembler,
        alchemy: () => 1,
      });

      expect(status).toBe(1);
      expect(containerCalls.map((c) => c.op)).toEqual(['locate']);
    });

    test('deploy never removes a container', async () => {
      const app = makeAppDir();
      process.chdir(app.dir);
      const containerCalls: ContainerCall[] = [];

      const status = await run(['deploy', app.entryPath, '--stage', 'staging'], {
        config: fakeConfig({}, { calls: containerCalls }),
        runAssembler: fakeAssembler,
        alchemy: () => 0,
      });

      expect(status).toBe(0);
      expect(containerCalls.map((c) => c.op)).toEqual(['ensure']);
    });
  });

  describe('the extension teardown hook on destroy', () => {
    test('destroy --stage staging runs teardown after alchemy and before the container is removed', async () => {
      const app = makeAppDir();
      process.chdir(app.dir);
      const order: string[] = [];

      const status = await run(['destroy', app.entryPath, '--stage', 'staging'], {
        config: fakeConfig(
          {
            teardown: async (input) => {
              const container = input.container as FakeContainer | undefined;
              order.push(
                `teardown:${container?.containerRef}/${container?.containerScope}/${input.stage}`,
              );
            },
          },
          { onRemove: () => void order.push('remove') },
        ),
        runAssembler: fakeAssembler,
        alchemy: () => {
          order.push('alchemy');
          return 0;
        },
      });

      expect(status).toBe(0);
      expect(order).toEqual(['alchemy', 'teardown:proj-fake/branch-staging/staging', 'remove']);
    });

    test('destroy --production runs teardown before the container is removed, naming no branch', async () => {
      const app = makeAppDir();
      process.chdir(app.dir);
      const order: string[] = [];

      const status = await run(['destroy', app.entryPath, '--production'], {
        config: fakeConfig(
          {
            teardown: async (input) => {
              const container = input.container as FakeContainer | undefined;
              order.push(
                `teardown:${container?.containerRef}/${container?.containerScope ?? 'none'}`,
              );
            },
          },
          { onRemove: () => void order.push('remove') },
        ),
        runAssembler: fakeAssembler,
        alchemy: () => {
          order.push('alchemy');
          return 0;
        },
      });

      expect(status).toBe(0);
      expect(order).toEqual(['alchemy', 'teardown:proj-fake/none', 'remove']);
    });

    test('a throwing teardown aborts the destroy and the container is left alone', async () => {
      const app = makeAppDir();
      process.chdir(app.dir);
      let removed = false;

      await expect(
        run(['destroy', app.entryPath, '--stage', 'staging'], {
          config: fakeConfig(
            {
              teardown: async () => {
                throw new Error('teardown said no');
              },
            },
            {
              onRemove: () => {
                removed = true;
              },
            },
          ),
          runAssembler: fakeAssembler,
          alchemy: () => 0,
        }),
      ).rejects.toThrow(/teardown said no/);

      expect(removed).toBe(false);
    });

    test('a teardown failure surfaces as a CliError', async () => {
      const app = makeAppDir();
      process.chdir(app.dir);

      await expect(
        run(['destroy', app.entryPath, '--stage', 'staging'], {
          config: fakeConfig({
            teardown: async () => {
              throw new Error('teardown said no');
            },
          }),
          runAssembler: fakeAssembler,
          alchemy: () => 0,
        }),
      ).rejects.toBeInstanceOf(CliError);
    });

    test('a FAILED alchemy destroy runs no teardown', async () => {
      const app = makeAppDir();
      process.chdir(app.dir);
      let torndown = false;

      const status = await run(['destroy', app.entryPath, '--stage', 'staging'], {
        config: fakeConfig({
          teardown: async () => {
            torndown = true;
          },
        }),
        runAssembler: fakeAssembler,
        alchemy: () => 1,
      });

      expect(status).toBe(1);
      expect(torndown).toBe(false);
    });

    test('deploy never runs teardown', async () => {
      const app = makeAppDir();
      process.chdir(app.dir);
      let torndown = false;

      const status = await run(['deploy', app.entryPath, '--stage', 'staging'], {
        config: fakeConfig({
          teardown: async () => {
            torndown = true;
          },
        }),
        runAssembler: fakeAssembler,
        alchemy: () => 0,
      });

      expect(status).toBe(0);
      expect(torndown).toBe(false);
    });

    test('an extension without a teardown hook is skipped, and the destroy completes', async () => {
      const app = makeAppDir();
      process.chdir(app.dir);

      const status = await run(['destroy', app.entryPath, '--stage', 'staging'], {
        config: fakeConfig(),
        runAssembler: fakeAssembler,
        alchemy: () => 0,
      });

      expect(status).toBe(0);
    });
  });
});
