import service from '../src/service.ts';

// service.load() needs the runtime environment, which doesn't exist at build
// time — so render per request instead of prerendering.
export const dynamic = 'force-dynamic';

export default async function Home() {
  const { auth } = service.load();
  const { ok } = await auth.verify({ token: 'demo-token' });
  const { ok: secretOk } = await auth.secretCheck({});

  return (
    <main>
      <h1>Storefront</h1>
      <p>Auth /verify says: {String(ok)}</p>
      <p>Secret /check says: {String(secretOk)}</p>
    </main>
  );
}
