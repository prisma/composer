/**
 * orders' public RPC contract. `placeOrder` snapshots the product's name and
 * price at placement time — later catalog changes don't rewrite history.
 */
import { contract, rpc } from '@prisma/compose/rpc';
import { type } from 'arktype';

export const order = type({
  id: 'string',
  productId: 'string',
  productName: 'string',
  quantity: 'number',
  totalCents: 'number',
  placedAt: 'string',
});

export type Order = typeof order.infer;

export const ordersContract = contract({
  placeOrder: rpc({
    input: type({ productId: 'string', quantity: 'number' }),
    output: type({ order: order.or('null') }),
  }),
  listOrders: rpc({
    input: type({}),
    output: type({ orders: order.array() }),
  }),
});
