import { module } from '@prisma/compose';
import { cron } from '@prisma/compose-prisma-cloud/cron';
import catalogModule from '@store/catalog';
import ordersModule from '@store/orders';
import promotionsService, { schedule } from '@store/promotions';
import storefrontService from '@store/storefront';

/**
 * The store app: four components, four edges.
 *
 *   storefront ──rpc──▶ catalog   (browse products)
 *   storefront ──rpc──▶ orders    (place + list orders)
 *   orders     ──rpc──▶ catalog   (price an order at placement time)
 *   cron       ──rpc──▶ catalog   (rotate the special of the day, every 30s)
 *
 * catalog and orders each own their own Postgres internally — the root never
 * sees it. All it wires are the exposed, typed rpc ports.
 *
 * `cron` is a SHARED module (@prisma/compose-prisma-cloud/cron), not app
 * code: it takes our schedule and our promotions runner, and its boundary
 * deps mirror the runner's own — so the root wires `catalog` into it exactly
 * as it would for any other consumer of that contract.
 */
export default module('store', ({ provision }) => {
  const catalog = provision(catalogModule);
  const orders = provision(ordersModule, { deps: { catalog: catalog.rpc } });

  provision(storefrontService, { deps: { catalog: catalog.rpc, orders: orders.rpc } });

  provision(cron({ schedule, runner: promotionsService }), {
    deps: { catalog: catalog.rpc },
  });
});
