import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'composer-destroy.ts');

const FAKE_CONTROL = `
import { writeFileSync } from 'node:fs';
export async function destroy(input) {
  const { onEvent, config, ...rest } = input;
  writeFileSync(process.env.FAKE_RECORD, JSON.stringify({ ...rest, file: config.file, section: config.value }));
  if (process.env.FAKE_EVENT === '1') onEvent?.({ kind: 'no-local-deploy-state', cwd: input.cwd });
  if (process.env.FAKE_FAIL !== '1') return { ok: true, value: undefined };
  const failure = new Error('The stack could not be torn down.');
  failure.code = 'DEPLOY.ENGINE_FAILED';
  failure.toEnvelope = () => ({
    ok: false,
    code: failure.code,
    severity: 'error',
    summary: failure.message,
    fix: 'Re-run destroy.',
  });
  return { ok: false, failure };
}
`;

let app: string;
let record: string;

function write(relativePath: string, content: string): void {
  const file = join(app, relativePath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function run(args: readonly string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: app,
    encoding: 'utf-8',
    env: { ...process.env, FAKE_RECORD: record, ...env },
  });
}

function recorded(): unknown {
  return JSON.parse(readFileSync(record, 'utf-8'));
}

beforeEach(() => {
  app = realpathSync(mkdtempSync(join(tmpdir(), 'composer-destroy-')));
  record = join(app, 'record.json');
  write('package.json', '{ "name": "app", "type": "module" }');
  write('prisma.config.ts', "export default { composer: { marker: 'section' }, orm: {} };\n");
  write(
    'node_modules/@prisma/composer/package.json',
    '{ "name": "@prisma/composer", "type": "module", "exports": { "./control": "./control.mjs" } }',
  );
  write('node_modules/@prisma/composer/control.mjs', FAKE_CONTROL);
});

afterEach(() => {
  rmSync(app, { recursive: true, force: true });
});

describe('composer-destroy', () => {
  it("passes the app's composer section, its file, the entry, the target and the name to destroy", () => {
    const result = run(['module.ts', '--production', '--name', 'orm-demo-ci-1']);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(recorded(), {
      entry: 'module.ts',
      target: { kind: 'production' },
      name: 'orm-demo-ci-1',
      cwd: app,
      file: join(app, 'prisma.config.ts'),
      section: { marker: 'section' },
    });
    assert.match(result.stdout, /Destroyed\./);
  });

  it('tears down a stage when --stage names one', () => {
    const result = run(['module.ts', '--stage', 'pr-12']);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(recorded(), {
      entry: 'module.ts',
      target: { kind: 'stage', stage: 'pr-12' },
      cwd: app,
      file: join(app, 'prisma.config.ts'),
      section: { marker: 'section' },
    });
  });

  it('prints the structured failure and exits 1 when destroy fails', () => {
    const result = run(['module.ts', '--production'], { FAKE_FAIL: '1' });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /"code": "DEPLOY\.ENGINE_FAILED"/);
    assert.match(result.stderr, /"summary": "The stack could not be torn down\."/);
    assert.match(result.stderr, /"fix": "Re-run destroy\."/);
  });

  it('warns when there is no local deploy state', () => {
    const result = run(['module.ts', '--production'], { FAKE_EVENT: '1' });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, new RegExp(`No prior deploy state under ${app}`));
  });

  for (const [label, args] of [
    ['no target', ['module.ts']],
    ['both targets', ['module.ts', '--production', '--stage', 'pr-12']],
    ['no entry', ['--production']],
    ['an unknown flag', ['module.ts', '--production', '--force']],
  ] as const) {
    it(`refuses ${label} without calling destroy`, () => {
      const result = run(args);

      assert.equal(result.status, 2);
      assert.match(result.stderr, /Usage: composer-destroy\.ts <entry>/);
      assert.throws(() => readFileSync(record));
    });
  }
});
