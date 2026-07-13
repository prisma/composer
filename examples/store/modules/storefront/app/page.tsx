import { revalidatePath } from 'next/cache';
import service from '../src/service.ts';

// service.load() needs the runtime environment, which doesn't exist at build
// time — so render per request instead of prerendering.
export const dynamic = 'force-dynamic';

const price = (cents: number) => `$${(cents / 100).toFixed(2)}`;

async function buy(formData: FormData) {
  'use server';
  const { orders } = service.load();
  await orders.placeOrder({ productId: String(formData.get('productId')), quantity: 1 });
  revalidatePath('/');
}

export default async function Home() {
  // Two typed clients, injected by the root module's wiring. This page
  // doesn't know where catalog and orders run — only their contracts.
  const { catalog, orders } = service.load();
  const [{ products }, { orders: recent }, { product: special }] = await Promise.all([
    catalog.listProducts({}),
    orders.listOrders({}),
    catalog.getSpecial({}),
  ]);

  return (
    <main>
      <h1>Compose Coffee</h1>
      <p className="tagline">
        A Prisma App: this Next.js storefront + a catalog module + an orders module.
      </p>

      <h2>Menu</h2>
      {products.map((p) => (
        <div className="product" key={p.id}>
          <div className="product-info">
            <strong>{p.name}</strong> <span className="price">{price(p.priceCents)}</span>
            {special?.id === p.id && <span className="special">★ today’s special</span>}
            <p>{p.description}</p>
          </div>
          <form action={buy}>
            <input type="hidden" name="productId" value={p.id} />
            <button type="submit">Buy</button>
          </form>
        </div>
      ))}

      <h2>Recent orders</h2>
      {recent.length === 0 && <p>No orders yet — buy something!</p>}
      {recent.map((o) => (
        <div className="order" key={o.id}>
          <span>
            {o.quantity} × {o.productName} — {price(o.totalCents)}
          </span>
          <time>{new Date(o.placedAt).toLocaleTimeString('en-US')}</time>
        </div>
      ))}
    </main>
  );
}
