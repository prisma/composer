/**
 * What the converge child writes when the parent's stdout is a pipe.
 *
 * In human format the engine starts the child with `output: "inherit"`, so a
 * piped `prisma deploy` hands its own stdout pipe to Alchemy. That pipe must
 * carry only the parent's data lines, so everything the child prints goes to
 * stderr instead.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  type ChildResult,
  defineCommand,
  defineCommandFamily,
  exitWithChildStatus,
} from '@prisma/cli-engine';
import { ok } from '@prisma/cli-engine/protocol';
import { createTestCli } from '@prisma/cli-engine/testing';
import { type AlchemyInvocation, alchemyInvocation } from '../../run-alchemy.ts';
import { type ConvergeContext, convergeSpawn, outputTransformMissing } from '../converge.ts';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** An app directory whose `@prisma/composer` depends on an `alchemy` that runs `body`. */
function appWithAlchemy(body: readonly string[]): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'composer-converge-spawn-')));
  tmpDirs.push(dir);
  const nodeModules = path.join(dir, 'node_modules');
  fs.mkdirSync(path.join(nodeModules, '@prisma', 'composer'), { recursive: true });
  fs.writeFileSync(
    path.join(nodeModules, '@prisma', 'composer', 'package.json'),
    JSON.stringify({ name: '@prisma/composer', exports: { './package.json': './package.json' } }),
  );
  fs.mkdirSync(path.join(nodeModules, 'alchemy', 'bin'), { recursive: true });
  fs.writeFileSync(
    path.join(nodeModules, 'alchemy', 'package.json'),
    JSON.stringify({ name: 'alchemy', type: 'commonjs', bin: { alchemy: './bin/cli.js' } }),
  );
  fs.writeFileSync(path.join(nodeModules, 'alchemy', 'bin', 'cli.js'), body.join('\n'));
  return dir;
}

/** The `prisma` host's spawn in `inherit` mode, where the inherited stdout is a pipe. */
function pipedInheritSpawn(captured: { stdout: string; stderr: string }): ConvergeContext {
  return {
    lastChild: () => undefined,
    spawn: (options) =>
      new Promise<ChildResult>((resolve, reject) => {
        const child = spawn(options.command, [...(options.args ?? [])], {
          cwd: options.cwd,
          env: { ...process.env, ...options.env },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout.on('data', (chunk) => {
          captured.stdout += String(chunk);
        });
        child.stderr.on('data', (chunk) => {
          captured.stderr += String(chunk);
        });
        child.on('error', reject);
        child.on('close', (exitCode, signal) => resolve({ exitCode, signal }));
      }),
  };
}

describe('convergeSpawn() with a piped stdout', () => {
  test("the child's console output and stdout writes reach stderr, and stdout stays empty", async () => {
    const cwd = appWithAlchemy([
      "console.log('Deploy · shop');",
      "console.info('[web] created');",
      "console.debug('debug detail');",
      "process.stdout.write('Plan: 1 to create\\n');",
    ]);
    const captured = { stdout: '', stderr: '' };
    const run = convergeSpawn(pipedInheritSpawn(captured));

    const outcome = await run(
      alchemyInvocation({
        command: 'deploy',
        stackFileRelativePath: '.prisma-composer/alchemy.run.ts',
        cwd,
        stage: 'test',
        containerEnv: {},
        redactedValues: [],
      }),
    );

    expect(outcome.exitCode).toBe(0);
    expect(captured).toEqual({
      stdout: '',
      stderr: 'Deploy · shop\n[web] created\ndebug detail\nPlan: 1 to create\n',
    });
  }, 15_000);

  test('the reproduce command stays the plain Alchemy command line', async () => {
    const cwd = appWithAlchemy([]);
    const run = convergeSpawn(pipedInheritSpawn({ stdout: '', stderr: '' }));

    const outcome = await run(
      alchemyInvocation({
        command: 'deploy',
        stackFileRelativePath: '.prisma-composer/alchemy.run.ts',
        cwd,
        stage: 'test',
        containerEnv: {},
        redactedValues: [],
      }),
    );

    expect(outcome.commandLine?.args.slice(1)).toEqual([
      'deploy',
      '.prisma-composer/alchemy.run.ts',
      '--yes',
      '--stage',
      'test',
    ]);
  }, 15_000);
});

const invocationIn = (cwd: string, redactedValues: readonly string[]): AlchemyInvocation =>
  alchemyInvocation({
    command: 'deploy',
    stackFileRelativePath: '.prisma-composer/alchemy.run.ts',
    cwd,
    stage: 'test',
    containerEnv: {},
    redactedValues,
  });

async function readAll(stream: TransformStream<string, string>, text: string): Promise<string> {
  const writer = stream.writable.getWriter();
  void writer.write(text);
  void writer.close();
  let out = '';
  const reader = stream.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out += value;
  }
}

describe("convergeSpawn() redacts the child's output through the engine", () => {
  const SECRET = 'hunter2-secret';

  function cliRunning(
    cwd: string,
    script: Parameters<typeof createTestCli>[0]['spawnScript'],
    beforeConverge: (ctx: {
      report: (event: { kind: 'endpoint'; name: string; url: string }) => void;
    }) => void = () => {},
  ) {
    const converge = defineCommand({
      help: { summary: 'Runs a converge' },
      maySpawn: true,
      handler: async (_args, ctx) => {
        beforeConverge(ctx);
        await convergeSpawn(ctx)(invocationIn(cwd, [SECRET]));
        return ok(exitWithChildStatus());
      },
    });
    const family = defineCommandFamily({ commands: { converge } });
    return createTestCli({
      commandFamilies: [family],
      commands: { ...family.commands },
      ...(script === undefined ? {} : { spawnScript: script }),
    });
  }

  test("the engine prints the child's output with every known secret redacted, a secret split across two chunks included, in human and json mode", async () => {
    const cwd = appWithAlchemy([]);
    const cli = cliRunning(cwd, (_request, child) => {
      child.write('stdout', 'key=hunter2-');
      child.write('stdout', 'secret\n');
      child.write('stderr', `boom ${SECRET}\n`);
      return { exitCode: 0, signal: null };
    });

    for (const format of [['--format', 'human'], ['--json']]) {
      const result = await cli.run(['converge', ...format]);
      const printed = result.stdout + result.stderr;

      expect(result.spawns[0]?.output).toBe('engine');
      expect(printed).not.toContain('hunter2');
      expect(printed).toContain('boom [redacted]\n');
      // In json mode both streams reach stderr, so the stderr line can fall inside the stdout text.
      expect(printed.replace('boom [redacted]\n', '')).toContain('key=[redacted]\n');
    }
  }, 15_000);

  test('the held-back text is printed before ctx.spawn resolves and before the report events the engine buffered', async () => {
    const cwd = appWithAlchemy([]);
    const cli = cliRunning(
      cwd,
      async (_request, child) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        child.write('stderr', 'tail-without-newline hunter');
        return { exitCode: 0, signal: null };
      },
      (ctx) => {
        setTimeout(
          () => ctx.report({ kind: 'endpoint', name: 'probe', url: 'https://probe.example' }),
          5,
        );
      },
    );

    const result = await cli.run(['converge', '--format', 'human']);

    const tail = result.stderr.indexOf('tail-without-newline hunter');
    expect(tail).toBeGreaterThan(-1);
    expect(tail).toBeLessThan(result.stderr.indexOf('https://probe.example'));
  }, 15_000);

  test("convergeSpawn gives the engine a transform per stream, and passes the secret values neither on the child's command line nor in its environment", async () => {
    const cwd = appWithAlchemy([]);
    let recorded: Parameters<ConvergeContext['spawn']>[0] | undefined;
    const ctx: ConvergeContext = {
      lastChild: () => undefined,
      spawn: async (options) => {
        recorded = options;
        return { exitCode: 0, signal: null };
      },
    };

    await convergeSpawn(ctx)(invocationIn(cwd, ['hunter2']));

    if (recorded?.transformOutput === undefined) throw new Error('no transform was given');
    expect(JSON.stringify(recorded.args)).not.toContain('hunter2');
    expect(Object.values(recorded.env ?? {}).join('\n')).not.toContain('hunter2');
    const stdout = recorded.transformOutput('stdout');
    const stderr = recorded.transformOutput('stderr');
    expect(stdout).not.toBe(stderr);
    expect(await readAll(stdout, 'a hunter2 b')).toBe('a [redacted] b');
    expect(await readAll(stderr, 'a hunter2 b')).toBe('a [redacted] b');
  });

  test("a host whose engine cannot transform a child's output refuses before starting anything", async () => {
    const cwd = appWithAlchemy([]);
    const commandWith = (passOptionNames: boolean) =>
      defineCommand({
        help: { summary: 'Runs a converge on an engine that may be older' },
        maySpawn: true,
        handler: async (_args, ctx) => {
          const host: ConvergeContext = {
            spawn: ctx.spawn,
            lastChild: ctx.lastChild,
            ...(passOptionNames && ctx.spawnOptionNames !== undefined
              ? { spawnOptionNames: ctx.spawnOptionNames }
              : {}),
          };
          const refused = outputTransformMissing(host);
          if (refused !== undefined) return refused;
          await convergeSpawn(ctx)(invocationIn(cwd, []));
          return ok(exitWithChildStatus());
        },
      });
    const family = defineCommandFamily({
      commands: { old: commandWith(false), current: commandWith(true) },
    });
    const cli = createTestCli({ commandFamilies: [family], commands: { ...family.commands } });

    const refused = await cli.run(['old', '--format', 'human']);
    expect(refused.exitCode).toBe(2);
    expect(refused.stderr).toContain('DEPS.CLI_ENGINE_INCOMPATIBLE');
    expect(refused.stderr).toContain(
      "This prisma CLI's @prisma/cli-engine is older than 0.10.0; Composer needs 0.10.0 or later.",
    );
    expect(refused.spawns).toEqual([]);

    const ran = await cli.run(['current', '--format', 'human']);
    expect(ran.spawns.length).toBe(1);
  }, 15_000);
});
