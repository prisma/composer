import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEPLOYMENT_RESULT_FILE_ENV,
  engineFailureCause,
  engineFailureFilePath,
  readEngineFailureCause,
  redactSecrets,
} from '../deployment-summary.ts';

const ESC = String.fromCharCode(27);
const red = (text: string) => `${ESC}[31m${text}${ESC}[0m`;

/** What `alchemy deploy --yes` printed to stdout (not a terminal) for a resource whose create threw. */
const alchemyFailedApply = [
  '[10:29:16.496] INFO (#1): Deploy · exp',
  '[10:29:16.538] INFO (#1): Plan: 1 to create',
  '[10:29:16.542] INFO (#53): [web] creating',
  `[10:29:16.556] INFO (#53): [web] ${red('fail')} — UnknownError: An error occurred in Effect.tryPromise (14ms)`,
  '[10:29:16.556] INFO (#1): ',
  '[10:29:16.556] INFO (#1): Failed: 0 succeeded, 1 failed (17ms)',
  `[10:29:16.997] ${red('ERROR')} (#1): UnknownError: An error occurred in Effect.tryPromise`,
  '    at catcher (/app/node_modules/effect/src/internal/effect.ts:1116:28)',
  '    at provider.create (/app/node_modules/alchemy/src/Apply.ts:136:14) {',
  '  [cause]: Error: Prisma API 409 Conflict: a deployment is already in progress',
  '      at <anonymous> (/app/.prisma-composer/alchemy.run.ts:12:61)',
  '}',
  '',
].join('\n');

describe('engineFailureCause', () => {
  test('keeps the failed resource row and the final error with its cause, without stack frames, info logs or colour', () => {
    expect(engineFailureCause(alchemyFailedApply, {})).toBe(
      [
        '[web] fail — UnknownError: An error occurred in Effect.tryPromise (14ms)',
        'UnknownError: An error occurred in Effect.tryPromise',
        '[cause]: Error: Prisma API 409 Conflict: a deployment is already in progress',
      ].join('\n'),
    );
  });

  test('an `error:` line counts as the start of the failure', () => {
    const output = 'Deploy · exp\n✗ error: Stage "exp" is locked by another deploy (lease 8c1f).\n';
    expect(engineFailureCause(output, {})).toBe(
      '✗ error: Stage "exp" is locked by another deploy (lease 8c1f).',
    );
  });

  test('with no failure line, falls back to the last five lines of the output', () => {
    const output = [
      'line 1',
      'line 2',
      'file:///app/.prisma-composer/alchemy.run.ts:3',
      "import config from '../prisma-composer.config.ts';",
      '       ^',
      "SyntaxError: The requested module '@prisma/composer/report' does not provide an export",
      '    at ModuleJob._instantiate (node:internal/modules/esm/module_job:180:21)',
      'Node.js v24.16.0',
    ].join('\n');

    expect(engineFailureCause(output, {})).toBe(
      [
        'file:///app/.prisma-composer/alchemy.run.ts:3',
        "import config from '../prisma-composer.config.ts';",
        '^',
        "SyntaxError: The requested module '@prisma/composer/report' does not provide an export",
        'Node.js v24.16.0',
      ].join('\n'),
    );
  });

  test('empty output has no cause', () => {
    expect(engineFailureCause('\n\n', {})).toBeUndefined();
  });

  test('caps the cause at 1000 characters', () => {
    const output = `error: ${'x'.repeat(5000)}`;
    const cause = engineFailureCause(output, {});
    expect(cause).toHaveLength(1000);
    expect(cause?.endsWith('…')).toBe(true);
  });

  test('redacts before capping, so a secret cut by the cap is never half-sent', () => {
    const token = `tok_${'s'.repeat(1200)}`;
    const cause = engineFailureCause(`error: ${token}`, { PRISMA_SERVICE_TOKEN: token });
    expect(cause).toBe('error: [redacted]');
  });
});

describe('redactSecrets', () => {
  test('removes the values of secret-named env vars, including the service token and preflight payloads', () => {
    const env = {
      PRISMA_SERVICE_TOKEN: 'svc-token-0123456789',
      PRISMA_COMPOSER_PREFLIGHT_PRISMA_COMPOSER_PRISMA_CLOUD: '{"STRIPE":"2024-01-01"}',
      STRIPE_SECRET_KEY: 'stripe-secret-value',
      PRISMA_API_URL: 'https://api.prisma.io',
    };
    const text =
      'token svc-token-0123456789 payload {"STRIPE":"2024-01-01"} key stripe-secret-value at https://api.prisma.io';

    expect(redactSecrets(text, env)).toBe(
      'token [redacted] payload [redacted] key [redacted] at https://api.prisma.io',
    );
  });

  test('leaves short values alone, so a placeholder does not blank every match', () => {
    expect(redactSecrets('status: pending', { API_TOKEN: 'pe' })).toBe('status: pending');
  });

  test('removes bearer tokens, JWTs, URL passwords and token=value pairs whatever their source', () => {
    const text = [
      'Authorization: Bearer abc.def-123',
      'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl',
      'postgres://app:hunter2secret@db.example.com:5432/app',
      'https://api.example.com/?api_key=k-123&x=1',
      '{"client_secret": "shh-its-secret"}',
    ].join('\n');

    expect(redactSecrets(text, {})).toBe(
      [
        'Authorization: Bearer [redacted]',
        'token [redacted]',
        'postgres://app:[redacted]@db.example.com:5432/app',
        'https://api.example.com/?api_key=[redacted]&x=1',
        '{"client_secret": "[redacted]"}',
      ].join('\n'),
    );
  });
});

describe('the failure cause through a real child process', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function runChild(exitCode: number) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prisma-composer-engine-failure-'));
    tmpDirs.push(dir);
    const modulePath = fileURLToPath(new URL('../deployment-summary.ts', import.meta.url));
    const childPath = path.join(dir, 'child.ts');
    fs.writeFileSync(
      childPath,
      `import { captureEngineFailure } from ${JSON.stringify(modulePath)};\n` +
        'captureEngineFailure();\n' +
        "console.log('[web] creating');\n" +
        `console.error('error: 409 Conflict (Authorization: Bearer ' + process.env.PRISMA_SERVICE_TOKEN + ')');\n` +
        `process.exitCode = ${String(exitCode)};\n`,
    );
    const resultFile = path.join(dir, 'deployment-result.json');
    const child = spawnSync(process.execPath, [childPath], {
      env: {
        ...process.env,
        PRISMA_SERVICE_TOKEN: 'real-service-token',
        [DEPLOYMENT_RESULT_FILE_ENV]: resultFile,
      },
      encoding: 'utf-8',
    });
    return { child, resultFile };
  }

  test('a non-zero exit leaves the redacted cause beside the result file, and the output still reaches the terminal unchanged', () => {
    const { child, resultFile } = runChild(1);

    expect(child.status).toBe(1);
    expect(child.stdout).toBe('[web] creating\n');
    expect(child.stderr).toBe('error: 409 Conflict (Authorization: Bearer real-service-token)\n');
    expect(readEngineFailureCause(resultFile)).toBe(
      'error: 409 Conflict (Authorization: Bearer [redacted])',
    );
  }, 15_000);

  test('a clean exit writes no cause', () => {
    const { child, resultFile } = runChild(0);

    expect(child.status).toBe(0);
    expect(fs.existsSync(engineFailureFilePath(resultFile))).toBe(false);
    expect(readEngineFailureCause(resultFile)).toBeUndefined();
  }, 15_000);
});
