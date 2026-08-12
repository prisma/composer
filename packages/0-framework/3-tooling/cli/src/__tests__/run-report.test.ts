import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  RUN_REPORT_VERSION,
  resolveRunReportPath,
  toRunReport,
  writeRunReport,
} from '../run-report.ts';

const summary = {
  app: 'storefront',
  nodes: [
    {
      address: 'storefront.web',
      entities: [{ kind: 'compute-service', id: 'app_1', url: 'https://web.example' }],
    },
  ],
};

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-report-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('toRunReport', () => {
  test('a successful run carries the app, its nodes, and no failure', () => {
    const report = toRunReport({ summary, stage: 'preview', failure: undefined });

    expect(report).toEqual({
      version: RUN_REPORT_VERSION,
      outcome: 'succeeded',
      app: 'storefront',
      stage: 'preview',
      nodes: summary.nodes,
      failure: null,
    });
  });

  test('a failed run before any summary still names its cause', () => {
    const report = toRunReport({
      summary: undefined,
      stage: undefined,
      failure: { code: 'DEPLOY.PREFLIGHT_FAILED', message: 'STRIPE_KEY is not set for preview.' },
    });

    expect(report.outcome).toBe('failed');
    expect(report.failure).toEqual({
      code: 'DEPLOY.PREFLIGHT_FAILED',
      message: 'STRIPE_KEY is not set for preview.',
    });
  });

  test('absent scalars are null rather than missing, so a consumer can read them unguarded', () => {
    const report = toRunReport({ summary: undefined, stage: undefined, failure: undefined });

    expect(Object.keys(report).sort()).toEqual([
      'app',
      'failure',
      'nodes',
      'outcome',
      'stage',
      'version',
    ]);
    expect(report.app).toBeNull();
    expect(report.stage).toBeNull();
    expect(report.nodes).toEqual([]);
  });
});

describe('resolveRunReportPath', () => {
  test('the flag wins over the environment variable', () => {
    expect(resolveRunReportPath('flag.json', 'env.json', '/work')).toBe('/work/flag.json');
  });

  test('the environment variable applies when no flag was passed', () => {
    expect(resolveRunReportPath(undefined, 'env.json', '/work')).toBe('/work/env.json');
  });

  test('an absolute path is left alone', () => {
    expect(resolveRunReportPath('/elsewhere/out.json', undefined, '/work')).toBe(
      '/elsewhere/out.json',
    );
  });

  test('neither asked for means no report is written', () => {
    expect(resolveRunReportPath(undefined, undefined, '/work')).toBeUndefined();
    expect(resolveRunReportPath('', '', '/work')).toBeUndefined();
  });
});

describe('writeRunReport', () => {
  test('writes parseable JSON, creating the parent directory', () => {
    const target = path.join(tempDir(), 'nested', 'run.json');
    const report = toRunReport({ summary, stage: undefined, failure: undefined });

    expect(writeRunReport(target, report)).toBe(true);
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual(report);
  });

  test('a path that cannot be written reports the failure instead of throwing', () => {
    const dir = tempDir();
    // The parent is a file, so no directory can be created under it.
    fs.writeFileSync(path.join(dir, 'blocked'), '');

    expect(
      writeRunReport(
        path.join(dir, 'blocked', 'run.json'),
        toRunReport({ summary, stage: undefined, failure: undefined }),
      ),
    ).toBe(false);
  });
});
