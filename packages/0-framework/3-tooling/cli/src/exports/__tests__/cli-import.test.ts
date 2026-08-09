/**
 * Pins the CLI entry's import-light guarantee structurally, the same way
 * control-import.test.ts pins the ./control entry's: a fresh bun process
 * imports src/cli.ts (bin.ts's one static import) with every heavy module
 * poisoned. This is what lets `--help` (and any command that loads no
 * executor) work even in a tree whose installed `effect` mismatches — the
 * effect preflight moved from bin.ts start-up to operation dispatch, so the
 * static graph itself must never reach alchemy/effect code.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

describe('the CLI entry (cli.ts)', () => {
  test('statically imports none of the heavy pipeline modules', () => {
    const dir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-composer-cli-import-')),
    );
    try {
      const cliPath = fileURLToPath(new URL('../../cli.ts', import.meta.url));
      const breakerPath = path.join(dir, 'poison-heavy-modules.ts');
      fs.writeFileSync(
        breakerPath,
        'Bun.plugin({\n' +
          "  name: 'poison-heavy-modules',\n" +
          '  setup(build) {\n' +
          '    build.onLoad(\n' +
          '      {\n' +
          '        filter:\n' +
          '          /(execute-deploy-destroy|execute-dev|execute-log|pipeline|load-entry|run-alchemy|generate-stack|generate-dev-stack|watch)\\.ts$/,\n' +
          '      },\n' +
          '      (args) => {\n' +
          "        throw new Error(`heavy module in the CLI entry's static graph: ${args.path}`);\n" +
          '      },\n' +
          '    );\n' +
          '  },\n' +
          '});\n',
      );
      const probePath = path.join(dir, 'probe.ts');
      fs.writeFileSync(probePath, `import ${JSON.stringify(cliPath)};\n`);

      const probe = spawnSync(process.execPath, ['--preload', breakerPath, probePath], {
        cwd: dir,
        encoding: 'utf-8',
      });

      expect(probe.error).toBeUndefined();
      expect(probe.stdout).toBe('');
      expect(probe.stderr).toBe('');
      expect(probe.status).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
