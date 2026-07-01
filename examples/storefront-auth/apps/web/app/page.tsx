// The Storefront calls the Auth service while serving the request — the
// ingress -> Auth path the MVP exercises. AUTH_URL is injected per environment
// (Slice 4 wiring); until then the page renders the reason it couldn't reach it.
async function getAuthStatus(): Promise<string> {
  const url = process.env.AUTH_URL;
  if (!url) return "AUTH_URL not set";
  try {
    const res = await fetch(url, { cache: "no-store" });
    return `${res.status}: ${(await res.text()).trim()}`;
  } catch (err) {
    return `auth call failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export default async function Home() {
  const auth = await getAuthStatus();
  return (
    <main>
      <h1>Storefront</h1>
      <p>Auth service says: {auth}</p>
    </main>
  );
}
