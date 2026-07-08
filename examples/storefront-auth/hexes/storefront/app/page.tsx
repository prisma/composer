import service from '../src/service.ts';

// service.load() needs the runtime environment, which doesn't exist at build
// time — so render per request instead of prerendering.
export const dynamic = 'force-dynamic';

async function getAuthStatus(): Promise<string> {
  const { auth } = service.load();
  try {
    const res = await auth.fetch('/verify');
    return `${res.status} ${(await res.text()).trim()}`;
  } catch (err) {
    return `auth call failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export default async function Home() {
  const auth = await getAuthStatus();
  return (
    <main>
      <h1>Storefront</h1>
      <p>Auth /verify says: {auth}</p>
    </main>
  );
}
