import { describe, expect, test } from 'bun:test';
import type { Graph } from '@internal/core';
import { domainsForBranch, validateDomains } from '../control/domain-config.ts';

const config = { main: { web: ['example.com'] }, staging: { web: ['staging.example.com'] } };
describe('custom domain configuration', () => {
  test('selects only the actual branch without aliases or inheritance', () => {
    expect(domainsForBranch(config, 'main')).toEqual({ web: ['example.com'] });
    expect(domainsForBranch(config, 'staging')).toEqual({ web: ['staging.example.com'] });
    expect(domainsForBranch(config, 'pr-42')).toEqual({});
    expect(domainsForBranch(config, 'production')).toEqual({});
    expect(domainsForBranch(config, 'trunk')).toEqual({});
  });
  test('rejects invalid hostnames and reuse across branches', () => {
    expect(() => validateDomains(config)).not.toThrow();
    expect(() => validateDomains({ main: { web: ['https://example.com'] } })).toThrow(
      'Invalid custom hostname',
    );
    expect(() => validateDomains({ ...config, staging: { web: ['EXAMPLE.COM'] } })).toThrow(
      'declared more than once',
    );
  });
  test('rejects declarations for unknown service addresses', () => {
    expect(() => validateDomains(config, { nodes: [] } as unknown as Graph)).toThrow(
      'unknown Compute service',
    );
  });
});
