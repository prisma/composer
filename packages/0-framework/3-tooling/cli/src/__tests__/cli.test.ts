/**
 * Pins cli()'s exit-code mapping (ADR-0044): usage errors and structured
 * failures are expected failures (exit 2); a non-structured escape is a bug
 * (exit 1 + report hint) — there are no fallback codes.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cli } from '../cli.ts';

afterEach(() => {
  // Reset to a concrete 0 — assigning `undefined` does not clear an
  // already-set exit code under bun, and a leaked nonzero exitCode fails the
  // whole `bun test` run despite 0 failing tests.
  process.exitCode = 0;
});

async function runCli(
  argv: readonly string[],
): Promise<{ code: number | undefined; stderr: string }> {
  const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  process.exitCode = 0;
  try {
    await cli(argv);
    return {
      code: typeof process.exitCode === 'number' ? process.exitCode : undefined,
      stderr: errorSpy.mock.calls.map((args) => args.join(' ')).join('\n'),
    };
  } finally {
    errorSpy.mockRestore();
  }
}

describe('cli() exit codes', () => {
  test('a usage error prints the usage banner and exits 2', async () => {
    const { code, stderr } = await runCli(['not-a-command']);
    expect(code).toBe(2);
    expect(stderr).toContain('prisma-composer deploy');
  });

  test('a structured failure renders the envelope and exits 2', async () => {
    const { code, stderr } = await runCli(['deploy', 'src/service.ts', '--production']);
    expect(code).toBe(2);
    expect(stderr).toContain('✖ --production is only valid with `destroy`. (DEPLOY.FLAG_INVALID)');
    expect(stderr).toContain('Fix: `deploy` targets production by default (omit --stage).');
  });

  test('a non-structured throw out of run() is a bug: exit 1 + report hint, no fallback code', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-composer-cli-bug-')));
    try {
      const cliPath = fileURLToPath(new URL('../cli.ts', import.meta.url));
      const breakerPath = path.join(dir, 'stub-run.ts');
      fs.writeFileSync(
        breakerPath,
        'Bun.plugin({\n' +
          "  name: 'stub-run',\n" +
          '  setup(build) {\n' +
          '    build.onLoad({ filter: /src\\/main\\.ts$/ }, () => ({\n' +
          '      contents: \'export async function run() { throw new Error("kaboom"); }\',\n' +
          "      loader: 'ts',\n" +
          '    }));\n' +
          '  },\n' +
          '});\n',
      );
      const probePath = path.join(dir, 'probe.ts');
      fs.writeFileSync(
        probePath,
        `const { cli } = await import(${JSON.stringify(cliPath)});\n` +
          "await cli(['deploy', 'service.ts']);\n" +
          'process.exit(process.exitCode ?? 0);\n',
      );

      const probe = spawnSync(process.execPath, ['--preload', breakerPath, probePath], {
        cwd: dir,
        encoding: 'utf-8',
      });

      expect(probe.status).toBe(1);
      expect(probe.stderr).toContain('Error: kaboom');
      expect(probe.stderr).toContain('https://github.com/prisma/composer/issues');
      expect(probe.stderr).not.toContain('✖');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
