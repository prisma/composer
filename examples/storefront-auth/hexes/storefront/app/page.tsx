// The Storefront calls the Auth service while serving the request — the
// ingress -> Auth path the MVP exercises. AUTH_URL is injected per environment
// (wired to the Auth hex in alchemy.run.ts); if unset the page says so.

// Render on every request so the runtime-injected AUTH_URL is used — otherwise
// Next prerenders this page at build time, when AUTH_URL is unset.
export const dynamic = 'force-dynamic';

async function getAuthStatus(): Promise<string> {
  const base = process.env.AUTH_URL;
  if (!base) return 'AUTH_URL not set';
  try {
    const res = await fetch(new URL('/verify', base), { cache: 'no-store' });
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
