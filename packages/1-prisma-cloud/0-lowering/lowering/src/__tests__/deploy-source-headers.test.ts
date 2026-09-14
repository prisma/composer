import { afterEach, describe, expect, test } from 'bun:test';
import pkg from '../../package.json' with { type: 'json' };
import { deploySourceHeaders } from '../credentials.ts';

describe('deploySourceHeaders', () => {
  const originalEnv = process.env['GITHUB_ACTIONS'];

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env['GITHUB_ACTIONS'];
    } else {
      process.env['GITHUB_ACTIONS'] = originalEnv;
    }
  });

  test('uses "github-action" as source when GITHUB_ACTIONS is "true"', () => {
    process.env['GITHUB_ACTIONS'] = 'true';
    expect(deploySourceHeaders()['x-prisma-deploy-source']).toBe('github-action');
  });

  test('uses "composer" as source outside GitHub Actions', () => {
    delete process.env['GITHUB_ACTIONS'];
    expect(deploySourceHeaders()['x-prisma-deploy-source']).toBe('composer');
  });

  test('uses "composer" as source when GITHUB_ACTIONS has another value', () => {
    process.env['GITHUB_ACTIONS'] = 'false';
    expect(deploySourceHeaders()['x-prisma-deploy-source']).toBe('composer');
  });

  test('always sets x-prisma-client-name to "composer"', () => {
    expect(deploySourceHeaders()['x-prisma-client-name']).toBe('composer');
  });

  test('sets x-prisma-client-version to the package version', () => {
    expect(pkg.version.length).toBeGreaterThan(0);
    expect(deploySourceHeaders()['x-prisma-client-version']).toBe(pkg.version);
  });
});
