/**
 * `authProxy()` against a stub upstream (spec § Proxy helper, every pinned
 * behavior): forwarded method/body/headers minus `host`, the two
 * x-forwarded-* headers, path+search preserved with NO rewriting, redirect
 * passthrough (`redirect: 'manual'`), set-cookie passthrough, and the 502
 * text on an unreachable upstream.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { authProxy } from '../proxy.ts';

interface Seen {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

let upstream: ReturnType<typeof Bun.serve>;
let seen: Seen[] = [];

beforeAll(() => {
  upstream = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (req) => {
      const url = new URL(req.url);
      seen.push({
        method: req.method,
        path: url.pathname + url.search,
        headers: Object.fromEntries(req.headers.entries()),
        body: await req.text(),
      });
      if (url.pathname === '/api/auth/redirect') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://app.example/done' },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 201,
        headers: {
          'content-type': 'application/json',
          'set-cookie': 'better-auth.session_token=abc; HttpOnly; Path=/',
        },
      });
    },
  });
});
afterAll(() => {
  upstream.stop(true);
});

const proxy = () => authProxy({ url: `http://127.0.0.1:${upstream.port}` });

describe('authProxy', () => {
  test('forwards method, body, and path+search verbatim — no path rewriting', async () => {
    seen = [];
    const res = await proxy()(
      new Request('https://app.example/api/auth/sign-in/email?foo=b%20ar', {
        method: 'POST',
        headers: { 'content-type': 'application/json', host: 'app.example' },
        body: JSON.stringify({ email: 'a@b.c' }),
      }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.path).toBe('/api/auth/sign-in/email?foo=b%20ar');
    expect(seen[0]?.body).toBe('{"email":"a@b.c"}');
  });

  test('drops host, keeps other headers, sets x-forwarded-host and x-forwarded-proto', async () => {
    seen = [];
    await proxy()(
      new Request('https://app.example/api/auth/session', {
        headers: {
          host: 'app.example',
          cookie: 'better-auth.session_token=abc',
          'x-custom': 'kept',
        },
      }),
    );
    const headers = seen[0]?.headers ?? {};
    // The upstream's own runtime sets host to ITSELF — the incoming host
    // must not leak through as `host`, it rides x-forwarded-host instead.
    expect(headers['host']).toBe(`127.0.0.1:${upstream.port}`);
    expect(headers['x-forwarded-host']).toBe('app.example');
    expect(headers['x-forwarded-proto']).toBe('https');
    expect(headers['cookie']).toBe('better-auth.session_token=abc');
    expect(headers['x-custom']).toBe('kept');
  });

  test('passes a redirect through untouched instead of following it', async () => {
    const res = await proxy()(new Request('https://app.example/api/auth/redirect'));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://app.example/done');
  });

  test('passes set-cookie through', async () => {
    const res = await proxy()(new Request('https://app.example/api/auth/session'));
    expect(res.headers.get('set-cookie')).toContain('better-auth.session_token=abc');
  });

  test('an unreachable upstream is a 502 with the pinned body', async () => {
    const res = await authProxy({ url: 'http://127.0.0.1:1' })(
      new Request('https://app.example/api/auth/session'),
    );
    expect(res.status).toBe(502);
    expect(await res.text()).toBe('auth proxy: upstream unreachable');
  });
});
