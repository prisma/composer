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
  if (process.env.FAKE_THROW === '1') throw new Error('entry did not load');
  const { onEvent, config, signal, ...rest } = input;
  writeFileSync(process.env.FAKE_RECORD, JSON.stringify({ ...rest, file: config.file, section: config.value }));
  if (process.env.FAKE_EVENT === '1') onEvent?.({ kind: 'no-local-deploy-state', cwd: input.cwd });
  if (process.env.FAKE_STEPS === '1') {
    onEvent?.({ kind: 'step-started', step: { name: 'apply' } });
    const resource = { name: 'apply-resource', resourceId: 'shop.web', resourceType: 'Prisma.Compute', status: 'deleted' };
    onEvent?.({ kind: 'step-started', step: resource });
    onEvent?.({ kind: 'message', severity: 'info', text: 'deleting shop.web' });
    onEvent?.({ kind: 'step-finished', step: resource, outcome: 'ok', durationMs: 5 });
    onEvent?.({ kind: 'step-finished', step: { name: 'apply' }, outcome: 'failed', durationMs: 7 });
  }
  if (process.env.FAKE_INTERRUPT === '1') {
    process.kill(process.pid, 'SIGINT');
    await new Promise((settle) => setTimeout(settle, 50));
    if (signal?.aborted !== true) throw new Error('Ctrl-C did not abort the signal');
    const failure = new Error('The destroy was interrupted.');
    failure.code = 'DEPLOY.INTERRUPTED';
    return { ok: false, failure };
  }
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
  // Under bun, a directory without node_modules would otherwise auto-install the published package.
  const runtimeArgs = process.versions.bun === undefined ? [] : ['--no-install'];
  return spawnSync(process.execPath, [...runtimeArgs, SCRIPT, ...args], {
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
  it("passes the app's composer section, its file, the entry, the environment and the name to destroy", () => {
    const result = run([
      '--entry',
      'module.ts',
      '--environment',
      'production',
      '--name',
      'orm-demo-ci-1',
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(recorded(), {
      entry: 'module.ts',
      environment: 'production',
      name: 'orm-demo-ci-1',
      cwd: app,
      file: join(app, 'prisma.config.ts'),
      section: { marker: 'section' },
    });
    assert.match(result.stdout, /Destroyed\./);
  });

  it('tears down the environment --environment names', () => {
    const result = run(['--entry', 'module.ts', '--environment', 'pr-12']);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(recorded(), {
      entry: 'module.ts',
      environment: 'pr-12',
      cwd: app,
      file: join(app, 'prisma.config.ts'),
      section: { marker: 'section' },
    });
  });

  it('prints the structured failure and exits 1 when destroy fails', () => {
    const result = run(['--entry', 'module.ts', '--environment', 'production'], { FAKE_FAIL: '1' });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /"code": "DEPLOY\.ENGINE_FAILED"/);
    assert.match(result.stderr, /"summary": "The stack could not be torn down\."/);
    assert.match(result.stderr, /"fix": "Re-run destroy\."/);
  });

  it('warns when there is no local deploy state', () => {
    const result = run(['--entry', 'module.ts', '--environment', 'production'], {
      FAKE_EVENT: '1',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, new RegExp(`No prior deploy state under ${app}`));
  });

  it('prints each step, resource and message destroy reports, one line each on stderr', () => {
    const result = run(['--entry', 'module.ts', '--environment', 'production'], {
      FAKE_STEPS: '1',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stderr.trim().split('\n'), [
      'started apply',
      'started shop.web (Prisma.Compute) deleted',
      'info: deleting shop.web',
      'finished shop.web (Prisma.Compute) deleted (5ms)',
      'failed apply (7ms)',
    ]);
  });

  it('interrupts destroy on Ctrl-C and reports the interruption', () => {
    const result = run(['--entry', 'module.ts', '--environment', 'production'], {
      FAKE_INTERRUPT: '1',
    });

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /The destroy was interrupted\./);
  });

  it('reads the config file --config names, relative to the current directory', () => {
    write('config/prisma.config.ts', "export default { composer: { marker: 'named' } };\n");

    const result = run([
      '--entry',
      'module.ts',
      '--environment',
      'production',
      '--config',
      'config/prisma.config.ts',
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(recorded(), {
      entry: 'module.ts',
      environment: 'production',
      cwd: app,
      file: join(app, 'config', 'prisma.config.ts'),
      section: { marker: 'named' },
    });
  });

  it('exits 1 with one line when the config file cannot be imported', () => {
    write('prisma.config.ts', "throw new Error('broken config');\n");

    const result = run(['--entry', 'module.ts', '--environment', 'production']);

    assert.equal(result.status, 1);
    assert.equal(
      result.stderr.trim(),
      `Could not import ${join(app, 'prisma.config.ts')}: broken config`,
    );
  });

  it('exits 1 with one line when the config file declares no composer section', () => {
    write('prisma.config.ts', 'export default { orm: {} };\n');

    const result = run(['--entry', 'module.ts', '--environment', 'production']);

    assert.equal(result.status, 1);
    assert.equal(
      result.stderr.trim(),
      `${join(app, 'prisma.config.ts')} declares no \`composer\` section.`,
    );
  });

  it('exits 1 with one line when @prisma/composer/control is not installed', () => {
    rmSync(join(app, 'node_modules'), { recursive: true, force: true });

    const result = run(['--entry', 'module.ts', '--environment', 'production']);

    assert.equal(result.status, 1);
    assert.match(result.stderr.trim(), /^Could not load @prisma\/composer\/control from [^\n]+$/);
  });

  it('exits 1 with one line when destroy throws instead of returning a failure', () => {
    const result = run(['--entry', 'module.ts', '--environment', 'production'], {
      FAKE_THROW: '1',
    });

    assert.equal(result.status, 1);
    assert.equal(result.stderr.trim(), 'destroy threw: entry did not load');
  });

  it("without --entry, passes no entry, so destroy uses the section's", () => {
    const result = run(['--environment', 'production']);

    assert.equal(result.status, 0, result.stderr);
    assert.equal((recorded() as { entry?: string }).entry, undefined);
  });

  for (const [label, args] of [
    ['no environment', ['--entry', 'module.ts']],
    ['an empty environment', ['--entry', 'module.ts', '--environment', '']],
    ['the retired --stage flag', ['--entry', 'module.ts', '--stage', 'pr-12']],
    ['the retired --production flag', ['--entry', 'module.ts', '--production']],
    ['a positional entry', ['module.ts', '--environment', 'production']],
    ['an unknown flag', ['--entry', 'module.ts', '--environment', 'production', '--force']],
  ] as const) {
    it(`refuses ${label} without calling destroy`, () => {
      const result = run(args);

      assert.equal(result.status, 2);
      assert.match(result.stderr, /Usage: composer-destroy\.ts --environment <name>/);
      assert.throws(() => readFileSync(record));
    });
  }
});
