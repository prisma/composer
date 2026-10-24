import { describe, expect, test } from 'bun:test';
import { type Graph, Load, module } from '@internal/core';
import { domainsForBranch, validateDomains } from '../control/domain-config.ts';
import { compute } from '../exports/index.ts';

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
  test('requires the full service address from the loaded app', () => {
    const graph = Load(
      module('shop', {}, ({ provision }) => {
        provision(
          compute({
            name: 'web',
            deps: {},
            build: {
              extension: '@prisma/composer/node',
              type: 'node',
              module: 'file:///test/web.ts',
              entry: 'server.js',
            },
          }),
        );
        return {};
      }),
    );
    expect(() => validateDomains({ main: { 'shop.web': ['example.com'] } }, graph)).not.toThrow();
    expect(() => validateDomains(config, graph)).toThrow('unknown Compute service "web"');
  });
});
