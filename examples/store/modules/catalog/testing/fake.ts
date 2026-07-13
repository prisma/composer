/**
 * An in-memory catalog for TESTING a module that depends on it — no Postgres,
 * no deploy. It serves the real `catalogContract`, so its handler map is
 * type-checked against the same contract the real catalog exposes. Test-only,
 * deliberately outside `src/`, so it never rides into the deployed artifact.
 */
import node from '@prisma/compose/node';
import { serve } from '@prisma/compose/rpc';
import { compute } from '@prisma/compose-prisma-cloud';
import { catalogContract, type Product } from '../src/contract.ts';

export const FAKE_PRODUCTS: Product[] = [
  { id: 'espresso', name: 'Espresso', description: 'A double shot.', priceCents: 350 },
  { id: 'croissant', name: 'Croissant', description: 'Baked every morning.', priceCents: 400 },
];

const fakeCatalog = compute({
  name: 'catalog-fake',
  deps: {},
  build: node({ module: import.meta.url, entry: 'fake.ts' }),
  expose: { rpc: catalogContract },
});

let specialIdx = 0;

export default serve(fakeCatalog, {
  rpc: {
    listProducts: async () => ({ products: FAKE_PRODUCTS }),
    getProduct: async ({ id }) => ({
      product: FAKE_PRODUCTS.find((p) => p.id === id) ?? null,
    }),
    getSpecial: async () => ({ product: FAKE_PRODUCTS[specialIdx] }),
    rotateSpecial: async () => {
      specialIdx = (specialIdx + 1) % FAKE_PRODUCTS.length;
      return { product: FAKE_PRODUCTS[specialIdx] };
    },
  },
});
