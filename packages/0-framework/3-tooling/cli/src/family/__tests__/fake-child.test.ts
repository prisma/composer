/**
 * The fake-child fixture is itself a contract: D3's spawn tests state a
 * child's behavior on argv and trust it. Each scripted behavior is proven
 * here against a real spawned process, so a test that fails over the fixture
 * is failing over the code under test, not the fixture.
 */
import { describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import * as path from 'node:path';

const FIXTURE = path.join(import.meta.dir, 'fixtures', 'fake-child.mjs');

function run(args: readonly string[], env?: Record<string, string>) {
  return spawnSync(process.execPath, [FIXTURE, ...args], {
    encoding: 'utf-8',
    ...(env === undefined ? {} : { env }),
  });
}

describe('the fake child', () => {
  test('exits with the scripted code — including the non-zero ones spawn tests must pass through', () => {
    for (const code of [0, 1, 2, 3]) {
      expect(run(['--exit', String(code)]).status).toBe(code);
    }
  });

  test('writes scripted stdout and stderr, unframed', () => {
    const result = run(['--stdout', 'plain child output', '--stderr', 'child warning']);
    expect(result.stdout).toBe('plain child output\n');
    expect(result.stderr).toBe('child warning\n');
  });

  test('reports env-key presence, never the value', () => {
    const set = run(['--report-env', 'PRISMA_SERVICE_TOKEN'], {
      PRISMA_SERVICE_TOKEN: 'secret-token-material',
    });
    expect(set.stdout).toBe('env:PRISMA_SERVICE_TOKEN=set\n');
    expect(set.stdout).not.toContain('secret-token-material');
    expect(run(['--report-env', 'PRISMA_SERVICE_TOKEN'], {}).stdout).toBe(
      'env:PRISMA_SERVICE_TOKEN=unset\n',
    );
  });

  test('a lingering child dies by the signal by default — a signal-killed child, not an exit code', async () => {
    const child = spawn(process.execPath, [FIXTURE, '--linger']);
    await new Promise((resolve) => setTimeout(resolve, 150));
    child.kill('SIGTERM');
    const [code, signal] = await new Promise<[number | null, string | null]>((resolve) => {
      child.on('exit', (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
    });
    expect(code).toBeNull();
    expect(signal).toBe('SIGTERM');
  });

  test('a lingering child scripted to report a signal names it and exits 0', async () => {
    const child = spawn(process.execPath, [FIXTURE, '--linger', '--on-signal', 'report']);
    await new Promise((resolve) => setTimeout(resolve, 150));
    child.kill('SIGINT');
    const chunks: string[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
    const code = await new Promise<number | null>((resolve) => {
      child.on('exit', (exitCode) => resolve(exitCode));
    });
    expect(code).toBe(0);
    expect(chunks.join('')).toBe('signal:SIGINT\n');
  });

  test('a lingering child scripted to ignore signals survives them — the escalation-ladder case', async () => {
    const child = spawn(process.execPath, [FIXTURE, '--linger', '--on-signal', 'ignore']);
    await new Promise((resolve) => setTimeout(resolve, 150));
    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(child.exitCode).toBeNull();
    child.kill('SIGKILL');
    await new Promise((resolve) => child.on('exit', resolve));
  });
});
