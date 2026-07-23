/**
 * `authProxy()` — the mount-anywhere forwarder for the public auth surface
 * (D11): the consumer app proxies `/api/auth/*` to the auth service so
 * browsers get first-party httpOnly cookies on the app's own origin, and
 * redirect flows (magic-link verify → callbackURL) land back on it.
 */

/** What the proxy needs of the wired `authApi()` binding — just the origin. */
export interface AuthProxyTarget {
  readonly url: string;
}

/**
 * Forwards method, body (streamed, not buffered), and all request headers
 * except `host`; sets `x-forwarded-host`/`x-forwarded-proto` from the
 * incoming request. The target URL is `new URL(pathname + search, api.url)`
 * — NO path rewriting: mount it so the incoming pathname already begins
 * `/api/auth` (Better Auth's basePath). The upstream response passes
 * through as-is (status, headers including set-cookie, body streamed);
 * `redirect: 'manual'` so 302s reach the browser. No retry, no timeout
 * beyond the platform's; a fetch failure surfaces as a 502.
 */
export function authProxy(api: AuthProxyTarget): (request: Request) => Promise<Response> {
  return async (request) => {
    const incoming = new URL(request.url);
    const target = new URL(incoming.pathname + incoming.search, api.url);

    const headers = new Headers(request.headers);
    headers.delete('host');
    headers.set('x-forwarded-host', request.headers.get('host') ?? incoming.host);
    headers.set('x-forwarded-proto', incoming.protocol.replace(':', ''));

    try {
      const upstream = await fetch(target, {
        method: request.method,
        headers,
        // GET/HEAD must not carry a body — fetch rejects the combination.
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
        redirect: 'manual',
      });
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: upstream.headers,
      });
    } catch {
      return new Response('auth proxy: upstream unreachable', { status: 502 });
    }
  };
}
