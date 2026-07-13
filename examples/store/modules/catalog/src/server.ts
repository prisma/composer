import { serve } from '@prisma/compose/rpc';
import { SQL } from 'bun';
import type { Product } from './contract.ts';
import service from './service.ts';

const { db } = service.load(); // db: PostgresConfig — the app owns its client
const { port } = service.config();

// One pool per process. idleTimeout closes the pooled connection before
// Compute's scale-to-zero drops it, so the next request reconnects instead of
// erroring (FT-5219).
const sql = new SQL({ url: db.url, max: 1, idleTimeout: 10 });

// A Prisma Postgres direct connection is closed when it goes idle. Bun.SQL
// surfaces that as an async error with no awaiter, which would otherwise
// crash the process into a restart loop.
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

await sql`
  create table if not exists products (
    id text primary key,
    name text not null,
    description text not null,
    price_cents integer not null
  )
`;
// Single-row table holding the current special of the day; the promotions
// cron job advances it via rotateSpecial.
await sql`
  create table if not exists special (
    singleton boolean primary key default true,
    product_id text not null
  )
`;
for (const p of SEED) {
  await sql`
    insert into products (id, name, description, price_cents)
    values (${p.id}, ${p.name}, ${p.description}, ${p.priceCents})
    on conflict (id) do nothing
  `;
}
await sql`
  insert into special (singleton, product_id)
  values (true, ${SEED[0].id})
  on conflict (singleton) do nothing
`;

const toProduct = (row: Record<string, unknown>): Product => ({
  id: String(row.id),
  name: String(row.name),
  description: String(row.description),
  priceCents: Number(row.price_cents),
});

const handler = serve(service, {
  rpc: {
    listProducts: async () => {
      const rows = await sql`select * from products order by name`;
      return { products: rows.map(toProduct) };
    },
    getProduct: async ({ id }) => {
      const rows = await sql`select * from products where id = ${id}`;
      return { product: rows.length > 0 ? toProduct(rows[0]) : null };
    },
    getSpecial: async () => {
      const rows = await sql`
        select p.* from special s join products p on p.id = s.product_id
      `;
      return { product: rows.length > 0 ? toProduct(rows[0]) : null };
    },
    rotateSpecial: async () => {
      const products = await sql`select * from products order by name`;
      if (products.length === 0) return { product: null };

      const current = await sql`select product_id from special`;
      const currentIdx = products.findIndex(
        (p: Record<string, unknown>) => p.id === current[0]?.product_id,
      );
      const next = toProduct(products[(currentIdx + 1) % products.length]);
      await sql`
        insert into special (singleton, product_id) values (true, ${next.id})
        on conflict (singleton) do update set product_id = ${next.id}
      `;
      return { product: next };
    },
  },
});
export default handler;

// Bind all interfaces — Compute routes external HTTP to the VM, so a
// loopback-only listener would be unreachable.
Bun.serve({ port, hostname: '0.0.0.0', fetch: handler });
