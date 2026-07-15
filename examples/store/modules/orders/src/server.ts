import { serve } from '@prisma/compose/rpc';
import service from './service.ts';

// load() hydrates both deps: `db` is the Prisma Next typed client (ADR-0022),
// `catalog` a typed client of catalogContract — both plain async calls.
const { db, catalog } = service.load();
const { port } = service.config();

// A Prisma Postgres direct connection is dropped when it idles / the service
// scales to zero; the lazy pool reconnects on the next query. Surface those
// as logs, not an uncaught crash into a 502 restart loop.
process.on('uncaughtException', (err) => console.error('uncaughtException', err));
process.on('unhandledRejection', (err) => console.error('unhandledRejection', err));

const handler = serve(service, {
  rpc: {
    placeOrder: async ({ productId, quantity }) => {
      const { product } = await catalog.getProduct({ id: productId });
      if (product === null || quantity < 1) return { order: null };

      const row = await db.orm.public.Order.create({
        productId: product.id,
        productName: product.name,
        quantity,
        totalCents: product.priceCents * quantity,
      });
      return { order: { ...row, placedAt: new Date(row.placedAt).toISOString() } };
    },
    listOrders: async () => {
      const rows = await db.orm.public.Order.orderBy((o) => o.placedAt.desc())
        .take(20)
        .all();
      return {
        orders: rows.map((o) => ({ ...o, placedAt: new Date(o.placedAt).toISOString() })),
      };
    },
  },
});
export default handler;

// Bind all interfaces — Compute routes external HTTP to the VM, so a
// loopback-only listener would be unreachable.
Bun.serve({ port, hostname: '0.0.0.0', fetch: handler });
