/**
 * Pins the control entry's import-light guarantee structurally: a fresh bun
 * process imports src/exports/control.ts with every heavy module poisoned
 * (executors, pipeline, alchemy runner, stack generators, watch). If the
 * entry's static graph ever reaches one of them, the import throws and this
 * test fails — the guarantee stops resting on doc comments.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

describe('the ./control entry', () => {
  test('statically imports none of the heavy pipeline modules', () => {
    const dir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-composer-control-import-')),
    );
    try {
      const controlPath = fileURLToPath(new URL('../control.ts', import.meta.url));
      const breakerPath = path.join(dir, 'poison-heavy-modules.ts');
      fs.writeFileSync(
        breakerPath,
        'Bun.plugin({\n' +
          "  name: 'poison-heavy-modules',\n" +
          '  setup(build) {\n' +
          '    build.onLoad(\n' +
          '      {\n' +
          '        filter:\n' +
          '          /(execute-deploy-destroy|execute-dev|execute-log|pipeline|run-alchemy|generate-stack|generate-dev-stack|watch|run-dev|run-log|main)\\.ts$/,\n' +
          '      },\n' +
          '      (args) => {\n' +
          "        throw new Error(`heavy module in the control entry's static graph: ${args.path}`);\n" +
          '      },\n' +
          '    );\n' +
          '  },\n' +
          '});\n',
      );
      const probePath = path.join(dir, 'probe.ts');
      fs.writeFileSync(probePath, `import ${JSON.stringify(controlPath)};\n`);

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
