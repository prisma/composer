import { describe, expect, test } from 'bun:test';
import { Load, module, resolve } from '@internal/core';
import { rawHttpContract } from '@internal/http';
import { compute } from '../compute.ts';
import { parseHostname, publicUrl, resolvedStrategy } from '../public-url.ts';

const build = {
  extension: '@prisma/composer/node',
  type: 'node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};
const web = compute({ name: 'web', deps: {}, build, expose: { http: rawHttpContract } });

describe('publicUrl()', () => {
  test('builds a public-url resource with one target slot wired to the target and props.url', () => {
    let node: ReturnType<typeof publicUrl> | undefined;
    const graph = Load(
      module('shop', ({ provision }) => {
        const svc = provision(web);
        node = publicUrl({ name: 'site', url: 'shop.com', target: svc.http });
        provision(node);
      }),
    );

    expect(node?.kind).toBe('resource');
    expect(node?.type).toBe('public-url');
    expect(node?.extension).toBe('@prisma/composer-prisma-cloud');
    expect(node?.provides).toBeUndefined();
    expect(Object.keys(node?.inputs ?? {})).toEqual(['target']);
    expect(node?.props).toEqual({ url: 'shop.com' });
    expect(graph.edges).toContainEqual({
      from: 'shop.web',
      to: 'shop.site',
      input: 'target',
      kind: 'dependency',
    });
  });

  test('omitting url throws, naming the public URL', () => {
    module('shop', ({ provision }) => {
      const svc = provision(web);
      expect(() =>
        publicUrl({ name: 'site', target: svc.http } as unknown as Parameters<typeof publicUrl>[0]),
      ).toThrow(
        'publicUrl("site"): url is required. Pass a hostname, publicUrl.hostname(…), or publicUrl.prismaBuild().',
      );
    });
  });

  test.each([
    ['https://shop.com', 'has a scheme'],
    ['shop.com/home', 'has a path'],
    ['shop.com:8080', 'has a port'],
    ['*.shop.com', 'has a "*" label'],
    ['10.0.0.1', 'is an IP address'],
    ['::1', 'is an IP address'],
    ['localhost', 'is not a hostname: it needs at least two labels'],
    ['-shop.com', 'has the label "-shop"'],
    ['shop_1.com', 'has the label "shop_1"'],
    [`${'a'.repeat(64)}.com`, 'has the label'],
    [`${'abcdefghi.'.repeat(26)}com`, 'is longer than 253 characters'],
  ])(
    'an invalid hostname %p throws at construction, naming the public URL and the problem',
    (url, problem) => {
      module('shop', ({ provision }) => {
        const svc = provision(web);
        expect(() => publicUrl({ name: 'site', url, target: svc.http })).toThrow(
          `publicUrl("site"): ${JSON.stringify(url)} ${problem}`,
        );
        expect(() =>
          publicUrl({
            name: 'site',
            url: { strategy: 'hostname', hostname: url },
            target: svc.http,
          }),
        ).toThrow(`publicUrl("site"): ${JSON.stringify(url)} ${problem}`);
      });
      expect(() => publicUrl.hostname(url)).toThrow(
        `publicUrl.hostname(): ${JSON.stringify(url)} ${problem}`,
      );
    },
  );

  test('a value is not checked at construction', () => {
    module('shop', ({ environment, provision }) => {
      const svc = provision(web);
      const url = resolve([environment.name], () => 'https://not checked here');
      expect(() => publicUrl({ name: 'site', url, target: svc.http })).not.toThrow();
    });
  });
});

describe('the hostname rule', () => {
  test('trims, drops one trailing dot and lowercases', () => {
    expect(parseHostname('  Shop.COM. ')).toBe('shop.com');
    expect(publicUrl.hostname('WWW.Shop.com.')).toEqual({
      strategy: 'hostname',
      hostname: 'www.shop.com',
    });
  });

  test('a 253-character name with 63-character labels is valid', () => {
    const name = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`;
    expect(name).toHaveLength(253);
    expect(parseHostname(name)).toBe(name);
  });

  test('both strategies are frozen plain data', () => {
    expect(Object.isFrozen(publicUrl.hostname('shop.com'))).toBe(true);
    expect(publicUrl.prismaBuild()).toEqual({ strategy: 'prisma-build' });
    expect(Object.isFrozen(publicUrl.prismaBuild())).toBe(true);
  });
});

describe('resolvedStrategy()', () => {
  test('a string means the hostname strategy', () => {
    expect(resolvedStrategy('Shop.com', 'shop.site')).toEqual({
      strategy: 'hostname',
      hostname: 'shop.com',
    });
  });

  test('accepts both strategies', () => {
    expect(resolvedStrategy(publicUrl.hostname('shop.com'), 'shop.site')).toEqual({
      strategy: 'hostname',
      hostname: 'shop.com',
    });
    expect(resolvedStrategy(publicUrl.prismaBuild(), 'shop.site')).toEqual({
      strategy: 'prisma-build',
    });
  });

  test.each([
    [42, '42'],
    [null, 'null'],
    [undefined, 'undefined'],
    [{ strategy: 'cname' }, '{"strategy":"cname"}'],
  ])('anything else throws, naming the address and what it got: %p', (url, shown) => {
    expect(() => resolvedStrategy(url, 'shop.site')).toThrow(
      `shop.site: url resolved to ${shown}, which is not a hostname or a public URL strategy.`,
    );
  });

  test('an invalid hostname throws, naming the address', () => {
    expect(() => resolvedStrategy('https://shop.com', 'shop.site')).toThrow(
      'shop.site: "https://shop.com" has a scheme',
    );
  });
});
