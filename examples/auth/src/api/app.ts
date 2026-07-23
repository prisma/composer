/**
 * The api service's request handling, separated from service.load() so the
 * local integration test can drive it with bindings pointed at
 * `startLocalAuthServer` (the same shapes the framework hydrates):
 *
 *   /api/auth/*  → authProxy(authApi)   (the browser golden path)
 *   /me          → Authorization: Bearer <jwt> verified STATELESSLY
 *   /session     → POST { token } → the session port's getSession
 *   /health      → 200
 */
import type { AuthApiClient, JwtVerifier } from '@prisma/composer-prisma-cloud/auth';
import { authProxy } from '@prisma/composer-prisma-cloud/auth';

export interface SessionPort {
  getSession(input: {
    token: string;
  }): Promise<{ session: { id: string } | null; user: { id: string; email: string } | null }>;
}

export interface ApiDeps {
  readonly authApi: AuthApiClient;
  readonly verifier: JwtVerifier;
  readonly session: SessionPort;
}

export function createApiApp(deps: ApiDeps): (request: Request) => Promise<Response> {
  const proxy = authProxy(deps.authApi);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  return async (request) => {
    const { pathname } = new URL(request.url);

    if (pathname.startsWith('/api/auth')) return proxy(request);

    if (pathname === '/me') {
      const header = request.headers.get('authorization') ?? '';
      const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
      // No DB access on this path — that is the JWT binding's whole value.
      const verified = token === '' ? null : await deps.verifier.verify(token);
      if (verified === null) return json({ error: 'unauthorized' }, 401);
      return json({
        userId: verified.userId,
        email: verified.email,
        sessionId: verified.sessionId,
      });
    }

    if (pathname === '/session' && request.method === 'POST') {
      const body: unknown = await request.json();
      const token =
        typeof body === 'object' &&
        body !== null &&
        'token' in body &&
        typeof body.token === 'string'
          ? body.token
          : undefined;
      if (token === undefined) return json({ error: 'token required' }, 400);
      return json(await deps.session.getSession({ token }));
    }

    if (pathname === '/health') return json({ ok: true });
    return json({ error: 'not found' }, 404);
  };
}
