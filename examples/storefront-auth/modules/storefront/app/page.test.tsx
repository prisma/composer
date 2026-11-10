/**
 * Unit proof (testing.md § Unit): mocks storefront's own service module so
 * `load()` returns a typed fake auth via `mockService`, then renders the page
 * directly — no server, no environment, no cloud.
 */
import { mockService } from '@prisma/composer/testing';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type Service from '../src/service.ts';

vi.mock('../src/service.ts', async () => {
  const actual = await vi.importActual<{ default: typeof Service }>('../src/service.ts');
  return {
    default: mockService(actual.default, {
      auth: {
        verify: async ({ token }) => ({ ok: token.length > 0 }),
        sign: async ({ challenge }) => ({ signature: `signature-of-${challenge}` }),
      },
    }),
  };
});

describe('Home (page.tsx)', () => {
  it('renders the storefront -> auth round trip with load() stubbed to a fake auth', async () => {
    const { default: Home } = await import('./page.tsx');

    const html = renderToStaticMarkup(await Home({ searchParams: Promise.resolve({}) }));

    expect(html).toContain('Auth /verify says: true');
    expect(html).not.toContain('Auth /sign says');
  });

  it('renders auth.sign() of the challenge query parameter', async () => {
    const { default: Home } = await import('./page.tsx');

    const html = renderToStaticMarkup(
      await Home({ searchParams: Promise.resolve({ challenge: 'abc' }) }),
    );

    expect(html).toContain('Auth /sign says: signature-of-abc');
  });
});
