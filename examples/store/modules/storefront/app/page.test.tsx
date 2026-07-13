/**
 * Unit proof (testing.md § Unit): mocks storefront's own service module so
 * `load()` returns typed fakes for catalog and orders via `mockService`, then
 * renders the page directly — no server, no environment, no cloud.
 */
import { mockService } from '@prisma/compose/testing';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type Service from '../src/service.ts';

vi.mock('../src/service.ts', async () => {
  const actual = await vi.importActual<{ default: typeof Service }>('../src/service.ts');
  return {
    default: mockService(actual.default, {
      catalog: {
        listProducts: async () => ({
          products: [
            { id: 'espresso', name: 'Espresso', description: 'A double shot.', priceCents: 350 },
          ],
        }),
        getProduct: async () => ({ product: null }),
        getSpecial: async () => ({
          product: {
            id: 'espresso',
            name: 'Espresso',
            description: 'A double shot.',
            priceCents: 350,
          },
        }),
        rotateSpecial: async () => ({ product: null }),
      },
      orders: {
        placeOrder: async () => ({ order: null }),
        listOrders: async () => ({
          orders: [
            {
              id: 'order-1',
              productId: 'espresso',
              productName: 'Espresso',
              quantity: 2,
              totalCents: 700,
              placedAt: '2026-07-13T08:00:00.000Z',
            },
          ],
        }),
      },
    }),
  };
});

describe('Home (page.tsx)', () => {
  it('renders products from catalog and orders from orders, load() stubbed to fakes', async () => {
    const { default: Home } = await import('./page.tsx');

    const html = renderToStaticMarkup(await Home());

    expect(html).toContain('Espresso');
    expect(html).toContain('$3.50');
    expect(html).toContain('$7.00');
    expect(html).toContain('today’s special');
  });
});
