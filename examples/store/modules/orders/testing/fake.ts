/**
 * An in-memory orders service for TESTING a module that depends on it — no
 * Postgres, no catalog, no deploy. It serves the real `ordersContract`, so its
 * handler map is type-checked against the same contract the real orders
 * exposes. Test-only, deliberately outside `src/`.
 */
import node from '@prisma/compose/node';
import { serve } from '@prisma/compose/rpc';
import { compute } from '@prisma/compose-prisma-cloud';
import { type Order, ordersContract } from '../src/contract.ts';

export const FAKE_ORDERS: Order[] = [
  {
    id: 'order-1',
    productId: 'espresso',
    productName: 'Espresso',
    quantity: 2,
    totalCents: 700,
    placedAt: '2026-07-13T08:00:00.000Z',
  },
];

const fakeOrders = compute({
  name: 'orders-fake',
  deps: {},
  build: node({ module: import.meta.url, entry: 'fake.ts' }),
  expose: { rpc: ordersContract },
});

export default serve(fakeOrders, {
  rpc: {
    placeOrder: async ({ productId, quantity }) => ({
      order: {
        id: `order-${FAKE_ORDERS.length + 1}`,
        productId,
        productName: productId,
        quantity,
        totalCents: 100 * quantity,
        placedAt: '2026-07-13T09:00:00.000Z',
      },
    }),
    listOrders: async () => ({ orders: FAKE_ORDERS }),
  },
});
