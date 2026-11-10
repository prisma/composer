import service from '../src/service.ts';

// service.load() needs the runtime environment, which doesn't exist at build
// time — so render per request instead of prerendering.
export const dynamic = 'force-dynamic';

interface HomeProps {
  readonly searchParams: Promise<{ challenge?: string | string[] }>;
}

export default async function Home({ searchParams }: HomeProps) {
  const { auth } = service.load();
  const { ok } = await auth.verify({ token: 'demo-token' });
  const { challenge } = await searchParams;
  const signature =
    typeof challenge === 'string' ? (await auth.sign({ challenge })).signature : undefined;

  return (
    <main>
      <h1>Storefront</h1>
      <p>Auth /verify says: {String(ok)}</p>
      {signature !== undefined && <p>Auth /sign says: {signature}</p>}
    </main>
  );
}
