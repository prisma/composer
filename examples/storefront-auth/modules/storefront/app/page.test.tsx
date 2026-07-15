/**
 * Unit proof (testing.md § Unit): mocks storefront's own service module so
 * `load()` returns a typed fake auth via `mockService`, then renders the page
 * directly — no server, no environment, no cloud.
 */
import { mockService } from '@prisma/compose/testing';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type Service from '../src/service.ts';

vi.mock('../src/service.ts', async () => {
  const actual = await vi.importActual<{ default: typeof Service }>('../src/service.ts');
  return {
    default: mockService(actual.default, {
      auth: {
        verify: async ({ token }) => ({ ok: token.length > 0 }),
        secretCheck: async () => ({ ok: true }),
      },
    }),
  };
});

describe('Home (page.tsx)', () => {
  it('renders the storefront -> auth round trip with load() stubbed to a fake auth', async () => {
    const { default: Home } = await import('./page.tsx');

    const html = renderToStaticMarkup(await Home());

    expect(html).toContain('Auth /verify says: true');
    expect(html).toContain('Secret /check says: true');
  });
});
