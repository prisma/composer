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
import type { ChildResult } from '@prisma/cli-engine';
import { alchemyInvocation } from '../../run-alchemy.ts';
import { type ConvergeContext, convergeSpawn } from '../dev-converge-child.ts';

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
