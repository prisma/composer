/**
 * The process-level half of the CLI's end-to-end coverage: the REBUILT
 * `prisma-composer` binary, spawned for real, asserted on its real exit codes
 * and real output.
 *
 * What only a process can prove is the shell itself — that the published bin
 * runs the engine at all, that it reports the version of the package that
 * shipped it, that it names itself `prisma-composer`, and that grammar,
 * credential and output-mode failures reach the user as the engine's exit
 * codes rather than a bespoke mapping. The semantics behind those commands are
 * covered in-process, against the engine's own harness, in
 * packages/0-framework/3-tooling/cli/src/family/__tests__/deploy-destroy.test.ts.
 *
 * Drives `node_modules/.bin/prisma-composer` — `@prisma/composer`'s built
 * `dist/bin.mjs` — the same binary a consumer installs.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const integrationDir = path.resolve(import.meta.dir, '..');
const composerBin = path.join(integrationDir, 'node_modules', '.bin', 'prisma-composer');

/** Runs the bin with no credential in the environment unless the caller adds one. */
function runCli(args: readonly string[], extraEnv: Record<string, string> = {}) {
  const env = { ...process.env };
  delete env['PRISMA_SERVICE_TOKEN'];
  delete env['PRISMA_WORKSPACE_ID'];
  const result = spawnSync(composerBin, [...args], {
    cwd: integrationDir,
    encoding: 'utf8',
    env: { ...env, ...extraEnv },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/** The version @prisma/composer's own manifest declares — the one the bin must report. */
function shippedVersion(): string {
  const manifest = path.join(integrationDir, 'node_modules', '@prisma', 'composer', 'package.json');
  const version: unknown = JSON.parse(fs.readFileSync(manifest, 'utf8')).version;
  if (typeof version !== 'string') throw new Error(`No version in ${manifest}`);
  return version;
}

describe('the prisma-composer binary', () => {
  test('reports the version of the package that shipped it', () => {
    const result = runCli(['--version']);

    expect(result.status).toBe(0);
    expect(result.output).toContain(shippedVersion());
  }, 30_000);

  test('names itself and lists the four commands it mounts', () => {
    const result = runCli(['--help']);

    expect(result.status).toBe(0);
    expect(result.output).toContain('prisma-composer deploy');
    expect(result.output).toContain('prisma-composer destroy');
    expect(result.output).toContain('prisma-composer dev');
    expect(result.output).toContain('prisma-composer log');
  }, 30_000);

  test('an unknown command is refused by name, exit 2', () => {
    const result = runCli(['not-a-command']);

    expect(result.status).toBe(2);
    expect(result.output).toContain('CLI.UNKNOWN_COMMAND');
    expect(result.output).toContain('not-a-command');
  }, 30_000);

  test('a missing argument is a grammar failure, exit 2', () => {
    const result = runCli(['deploy']);

    expect(result.status).toBe(2);
    expect(result.output).toContain('CLI.INVALID_ARGUMENTS');
    expect(result.output).toContain('entry');
  }, 30_000);

  test('an unknown flag is a grammar failure, exit 2', () => {
    const result = runCli(['deploy', 'service.ts', '--nope']);

    expect(result.status).toBe(2);
    expect(result.output).toContain('CLI.INVALID_ARGUMENTS');
    expect(result.output).toContain('--nope');
  }, 30_000);

  /**
   * A deploy hands the terminal to alchemy, whose output nothing here can
   * frame — so the whole run is refused up front rather than started and then
   * abandoned mid-stream.
   */
  test('--json is refused on deploy, exit 2', () => {
    const result = runCli(['deploy', 'service.ts', '--json']);

    expect(result.status).toBe(2);
    expect(result.output).toContain('CLI.JSON_UNSUPPORTED');
  }, 30_000);

  test('a signed-out deploy is refused before it evaluates anything, exit 2', () => {
    const result = runCli(['deploy', 'service.ts']);

    expect(result.status).toBe(2);
    expect(result.output).toContain('CLI.CREDENTIALS_REQUIRED');
  }, 30_000);
});
