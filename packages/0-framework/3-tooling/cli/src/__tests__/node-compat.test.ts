/**
 * The CLI must run under node (>= 22.18, default type stripping) as well as
 * bun (design-notes.md's "CLI runtime" call). This is the one test in the
 * suite that actually spawns a separate node process, proving `bin.ts`
 * itself — not just its pieces — works there.
 *
 * It is a smoke test of the SHELL, not of the grammar: what it has to show is
 * that a real node process gets through the engine's front door and back out
 * with the right exit code. The engine's own behavior is covered in-process.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const packageDir = path.join(import.meta.dir, '..', '..');
const binPath = path.join(packageDir, 'src', 'bin.ts');

function runUnderNode(args: readonly string[]) {
  const result = spawnSync('node', [binPath, ...args], { encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe('node compatibility smoke test', () => {
  /**
   * A bare invocation is a request for help under the engine, so it succeeds.
   * The legacy CLI treated it as a usage error and exited nonzero.
   */
  test('a bare invocation under node prints the usage banner and exits 0', () => {
    const result = runUnderNode([]);

    // The engine's help renderer lists commands by name alone ('deploy
    // <entry>'), no longer prefixed with the binary ('prisma-composer
    // deploy'); the banner still opens with the binary name.
    expect(result.status).toBe(0);
    expect(result.output).toContain('prisma-composer');
    expect(result.output).toContain('deploy <entry>');
    expect(result.output).toContain('dev <entry>');
    expect(result.output).toContain('destroy <entry>');
  }, 15000);

  test('an unknown command under node is refused by name, exit 2', () => {
    const result = runUnderNode(['build', 'src/service.ts']);

    expect(result.status).toBe(2);
    expect(result.output).toContain('CLI.UNKNOWN_COMMAND');
    expect(result.output).toContain('build');
  }, 15000);

  /** Proves the version read works under node's type stripping, not just under bun. */
  test('--version under node reports the version of the package the module sits in', () => {
    const version: unknown = JSON.parse(
      fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'),
    ).version;
    const result = runUnderNode(['--version']);

    expect(result.status).toBe(0);
    expect(result.output).toContain(String(version));
  }, 15000);
});
