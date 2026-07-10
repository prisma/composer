/**
 * Drives main.ts's run() end to end with fakes at the module seams the CLI
 * already exposes (RunDeps): a fake assembler (no real wrapper build) and a
 * fake alchemy runner (no real process). The entry module and the generated
 * stack file are real — written to a temp dir.
 *
 * `.prisma-app/` lands in the process's own cwd (ADR-0004's rewrite — tool
 * state lives where you run the tool), so each test chdir's into the fixture
 * app dir for the duration of run(), the same way a real invocation's cwd is
 * wherever the app's package script runs from.
 *
 * the target node.loadTarget() is NOT faked — it imports the real target module for the
 * fixture service's node (node-owned loading: @prisma/app's node.ts does
 * the actual `import()`). The fixture's `targetModule` is a real `file://`
 * URL to a throwaway module written to a temp dir — not a package specifier
 * resolved through node_modules — so this suite proves the CLI's own
 * pipeline without depending on any specific target/adapter pack, or on the
 * workspace's real node_modules layout (that proof lives in
 * test/integration, against the built CLI binary and real packs).
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ServiceNode } from '@prisma/app';
import { CliError } from '../cli-error.ts';
import { run } from '../main.ts';
import type { RunAlchemyInput } from '../run-alchemy.ts';

const coreIndex = path.resolve(import.meta.dir, '..', '..', '..', 'app', 'src', 'index.ts');

const tmpDirs: string[] = [];
const originalCwd = process.cwd();

/** A real, importable fixture target module — a file:// URL, not a package specifier. */
function writeFixtureTargetModule(dir: string): string {
  const file = path.join(dir, 'fixture-target.ts');
  fs.writeFileSync(file, "export function fromEnv() { return { name: 'fixture-target' }; }\n");
  return pathToFileURL(file).href;
}

/**
 * A real app package in a temp dir: package.json + an entry module whose
 * default export is a genuine service node (importing core by absolute path
 * — the temp dir has no other node_modules). `targetModule` is a real
 * file:// URL (see writeFixtureTargetModule) so the real target
 * `loadTarget()` call succeeds without any real Prisma App target/adapter pack.
 */
function makeAppDir(name = 'fixture-app'): { dir: string; entryPath: string } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-app-cli-run-')));
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture-app' }));
  const targetModule = writeFixtureTargetModule(dir);
  const entryPath = path.join(dir, 'service.ts');
  fs.writeFileSync(
    entryPath,
    [
      `import { system, service } from ${JSON.stringify(coreIndex)};`,
      '',
      `export default system(${JSON.stringify(name)}, {}, ({ provision }) => {`,
      `  provision(${JSON.stringify(name)}, service({`,
      `    name: ${JSON.stringify(name)},`,
      "    pack: 'fixture-target-pack',",
      "    type: 'fixture/compute',",
      '    inputs: {},',
      '    params: {},',
      "    build: { kind: 'node', assembler: '@prisma/app-node/assemble', module: import.meta.url, entry: 'dist/server.js' },",
      `    targetModule: ${JSON.stringify(targetModule)},`,
      '  }));',
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
  test('a successful deploy generates the stack file and invokes alchemy against it', async () => {
    const app = makeAppDir('hello-run');
    process.chdir(app.dir);
    const calls: RunAlchemyInput[] = [];

    const status = await run(['deploy', app.entryPath, '--stage', 'ci-7'], {
      runAssembler: fakeAssembler,
      alchemy: (input) => {
        calls.push(input);
        return 0;
      },
    });

    expect(status).toBe(0);
    expect(calls).toEqual([
      {
        command: 'deploy',
        stackFileRelativePath: path.join('.prisma-app', 'alchemy.run.ts'),
        cwd: app.dir,
        stage: 'ci-7',
      },
    ]);

    const stackPath = path.join(app.dir, '.prisma-app', 'alchemy.run.ts');
    const content = fs.readFileSync(stackPath, 'utf8');
    expect(content).toContain('name: "hello-run"');
    expect(content).toContain('import app from "../service.ts";');
    expect(content).toContain(
      `"hello-run": { dir: ${JSON.stringify(path.join(app.dir, 'dist', 'bundle'))}, entry: "server.js" }`,
    );
  });

  test('--name with an empty value is a CliError naming the fix', async () => {
    const app = makeAppDir();
    process.chdir(app.dir);

    await expect(
      run(['deploy', app.entryPath, '--name', ''], {
        runAssembler: fakeAssembler,
        alchemy: () => 0,
      }),
    ).rejects.toThrow(CliError);
    await expect(
      run(['deploy', app.entryPath, '--name', ''], {
        runAssembler: fakeAssembler,
        alchemy: () => 0,
      }),
    ).rejects.toThrow(/name it at authoring, or pass --name/);
  });

  test('an alchemy failure propagates the nonzero exit and prints the generated file path', async () => {
    const app = makeAppDir();
    process.chdir(app.dir);
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const status = await run(['deploy', app.entryPath], {
        runAssembler: fakeAssembler,
        alchemy: () => 42,
      });

      expect(status).toBe(42);
      const stackPath = path.join(app.dir, '.prisma-app', 'alchemy.run.ts');
      const printed = errorSpy.mock.calls.map((args) => args.join(' ')).join('\n');
      expect(printed).toContain(stackPath);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('a destroy blocked by missing built output explains that destroy needs the build too', async () => {
    const app = makeAppDir();
    process.chdir(app.dir);
    const failingAssembler = async () => {
      throw new Error('no built entry at /some/dist/server.js — run this app’s own build first');
    };

    const error: unknown = await run(['destroy', app.entryPath], {
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
        const status = await run(['destroy', app.entryPath], {
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
        await run(['destroy', app.entryPath], { runAssembler: fakeAssembler, alchemy: () => 0 });

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
        await run(['destroy', app.entryPath], { runAssembler: fakeAssembler, alchemy: () => 0 });

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
        await run(['deploy', app.entryPath], { runAssembler: fakeAssembler, alchemy: () => 0 });

        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });
  });
});
