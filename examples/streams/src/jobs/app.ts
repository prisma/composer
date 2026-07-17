/**
 * A tiny job-log app that uses the streams module as its event log. It builds
 * its own Durable Streams HTTP client (ADR-0015) from the `StreamsConfig`
 * binding — endpoint URL and the deploy-minted bearer key, both delivered
 * through the binding (ADR-0031), so the app declares no secret and reads no
 * environment.
 *
 *   POST /jobs        append one event; body is the event JSON
 *   GET  /jobs        read the whole log back (from offset -1)
 *   GET  /jobs/tail   long-poll from the current head for the next event
 *
 * `createJobsApp` returns a plain `Request → Response` handler so the same app
 * runs behind `Bun.serve` in the deployed service and inside the integration
 * test with no server.
 *
 * It calls the streams service with a plain `fetch` and carries no retry,
 * backoff, or platform-specific handling — deliberately. A Compute service
 * scales to zero, and the first call after an idle spell can have its
 * connection closed while the instance boots, so a request here can fail where
 * a warm one would not (gotchas.md, PRO-217/PRO-219). That is the platform's
 * behaviour to fix, not something every app should hand-roll around: an
 * example that absorbed it would teach the boilerplate and hide the gap. The
 * handler below surfaces such a failure as a 502 naming its cause, which is
 * ordinary hygiene, and stops there.
 */
import type { StreamsConfig } from '@prisma/composer-prisma-cloud/streams';

const STREAM = 'jobs';

export function createJobsApp(config: StreamsConfig): (req: Request) => Promise<Response> {
  const base = `${config.url.replace(/\/$/, '')}/v1/stream/${STREAM}`;
  const authed = (init: RequestInit = {}): RequestInit => ({
    ...init,
    headers: { ...init.headers, authorization: `Bearer ${config.apiKey}` },
  });
  const json = (init: RequestInit = {}): RequestInit => ({
    ...authed(init),
    headers: { ...authed().headers, 'content-type': 'application/json' },
  });

  let created: Promise<void> | undefined;
  // The stream is created once per instance; PUT is idempotent, so a racing
  // second instance re-creating it is harmless.
  const ensureStream = (): Promise<void> => {
    created ??= fetch(base, json({ method: 'PUT' })).then((res) => {
      if (!res.ok && res.status !== 409) {
        created = undefined;
        throw new Error(`could not create the stream: ${res.status}`);
      }
    });
    return created;
  };

  const append = async (req: Request): Promise<Response> => {
    await ensureStream();
    const event = await req.json();
    // Not retried, and nothing here retries anything: without an idempotency
    // key a failed request is indistinguishable from one that applied, so a
    // retry risks duplicate events. The caller retries, because only it knows
    // whether a duplicate is acceptable.
    const res = await fetch(base, json({ method: 'POST', body: JSON.stringify([event]) }));
    if (!res.ok) return new Response(`append failed: ${res.status}`, { status: 502 });
    return Response.json({ appended: event }, { status: 201 });
  };

  const read = async (): Promise<Response> => {
    await ensureStream();
    const res = await fetch(`${base}?offset=-1&format=json`, authed());
    if (!res.ok) return new Response(`read failed: ${res.status}`, { status: 502 });
    return Response.json({
      events: await res.json(),
      nextOffset: res.headers.get('stream-next-offset'),
    });
  };

  // Live tail through the ingress: long-poll, not SSE — the Compute ingress
  // buffers streaming responses until completion (PRO-218), so an open SSE
  // tail never delivers. Each long-poll delivery is a completing response.
  const tail = async (url: URL): Promise<Response> => {
    await ensureStream();
    const timeout = url.searchParams.get('timeout') ?? '20s';
    const head = await fetch(`${base}?offset=-1&format=json`, authed());
    const offset = head.headers.get('stream-next-offset');
    const res = await fetch(
      `${base}?offset=${offset}&format=json&live=long-poll&timeout=${timeout}`,
      authed(),
    );
    if (res.status === 204) return Response.json({ events: [], timedOut: true });
    if (!res.ok) return new Response(`tail failed: ${res.status}`, { status: 502 });
    return Response.json({ events: await res.json(), timedOut: false });
  };

  const route = async (req: Request, url: URL): Promise<Response> => {
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response('jobs — POST /jobs, GET /jobs, GET /jobs/tail\n');
    }
    if (url.pathname === '/jobs/tail' && req.method === 'GET') return tail(url);
    if (url.pathname === '/jobs') {
      if (req.method === 'POST') return append(req);
      if (req.method === 'GET') return read();
      return new Response('method not allowed', { status: 405 });
    }
    return new Response('not found', { status: 404 });
  };

  return async (req: Request): Promise<Response> => {
    try {
      return await route(req, new URL(req.url));
    } catch (error) {
      // An unreachable dependency is this app's upstream problem, not the
      // caller's mistake: say so as 502, naming the cause, rather than letting
      // the throw become an opaque 500.
      console.error('jobs: request failed', error);
      return new Response(`streams unreachable: ${String(error)}`, { status: 502 });
    }
  };
}
