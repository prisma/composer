import { serve } from '@prisma/compose/rpc';
import type { Product } from './contract.ts';
import service from './service.ts';

// load() hydrates `db` into the typed Prisma Next client (ADR-0022) — no SQL,
// no row mapping; queries are typed by contract.prisma's emitted contract.
const { db } = service.load();
const { port } = service.config();

// A Prisma Postgres direct connection is dropped when it idles / the service
// scales to zero; the lazy pool reconnects on the next query. Surface those
// as logs, not an uncaught crash into a 502 restart loop.
process.on('uncaughtException', (err) => console.error('uncaughtException', err));
process.on('unhandledRejection', (err) => console.error('unhandledRejection', err));

const SEED: Product[] = [
  {
    id: 'espresso',
    name: 'Espresso',
    description: 'A double shot, pulled short.',
    priceCents: 350,
  },
  {
    id: 'flat-white',
    name: 'Flat White',
    description: 'Silky microfoam over a double shot.',
    priceCents: 450,
  },
  {
    id: 'cold-brew',
    name: 'Cold Brew',
    description: 'Steeped 18 hours, served over ice.',
    priceCents: 500,
  },
  { id: 'croissant', name: 'Croissant', description: 'Baked every morning.', priceCents: 400 },
];

// Idempotent boot seed. The schema itself is NOT created here — the deploy's
// migration step applied migrations/ before this service ever started.
for (const p of SEED) {
  await db.orm.public.Product.upsert({ create: p, update: {} });
}
await db.orm.public.Special.upsert({ create: { id: 1, productId: SEED[0].id }, update: {} });

const handler = serve(service, {
  rpc: {
    listProducts: async () => ({
      products: await db.orm.public.Product.orderBy((p) => p.name.asc()).all(),
    }),
    getProduct: async ({ id }) => ({
      product: (await db.orm.public.Product.where({ id }).first()) ?? null,
    }),
    getSpecial: async () => {
      const special = await db.orm.public.Special.where({ id: 1 }).first();
      if (!special) return { product: null };
      const product = await db.orm.public.Product.where({ id: special.productId }).first();
      return { product: product ?? null };
    },
    rotateSpecial: async () => {
      const products = await db.orm.public.Product.orderBy((p) => p.name.asc()).all();
      if (products.length === 0) return { product: null };

      const special = await db.orm.public.Special.where({ id: 1 }).first();
      const currentIdx = products.findIndex((p) => p.id === special?.productId);
      const next = products[(currentIdx + 1) % products.length];
      await db.orm.public.Special.upsert({
        create: { id: 1, productId: next.id },
        update: { productId: next.id },
      });
      return { product: next };
    },
  },
});
export default handler;

// Bind all interfaces — Compute routes external HTTP to the VM, so a
// loopback-only listener would be unreachable.
Bun.serve({ port, hostname: '0.0.0.0', fetch: handler });
