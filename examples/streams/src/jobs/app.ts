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
 */
import type { StreamsConfig } from '@prisma/composer-prisma-cloud/streams';

const STREAM = 'jobs';

/** Edge statuses that mean "the service isn't up yet", not "your request was wrong". */
const COLD_START_STATUS = new Set([502, 503, 504]);

/**
 * The streams service scales to zero, so the first call after an idle spell can
 * be reset mid-connect or answered 502 by the edge while the instance boots
 * (Prisma Compute, PRO-217). Retry ONLY that: a bounded backoff, and only for
 * calls that are safe to repeat — a real failure (401, a malformed append) must
 * still surface on the first try. Appends are deliberately not retried here:
 * a write that may have reached the server cannot be blindly repeated.
 */
async function fetchIdempotent(url: string, init?: RequestInit): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
    try {
      const res = await fetch(url, init);
      if (!COLD_START_STATUS.has(res.status)) return res;
      lastError = new Error(`streams is cold: ${res.status}`);
    } catch (error) {
      lastError = error; // the socket closed while the instance was starting
    }
  }
  throw lastError;
}

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
  // second instance re-creating it is harmless — and it is this first touch
  // that rides out a cold streams service for every call behind it.
  const ensureStream = (): Promise<void> => {
    created ??= fetchIdempotent(base, json({ method: 'PUT' })).then((res) => {
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
    // Appends are not retried: without an idempotency key, a failed request is
    // indistinguishable from one that applied, so retrying risks duplicate
    // events (gotchas.md, PRO-217). The first append is shielded by the retried
    // PUT above; a later one can still meet a cold service and surface 502 —
    // the caller retries, because only it knows whether a duplicate is
    // acceptable.
    const res = await fetch(base, json({ method: 'POST', body: JSON.stringify([event]) }));
    if (!res.ok) return new Response(`append failed: ${res.status}`, { status: 502 });
    return Response.json({ appended: event }, { status: 201 });
  };

  const read = async (): Promise<Response> => {
    await ensureStream();
    const res = await fetchIdempotent(`${base}?offset=-1&format=json`, authed());
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
    const head = await fetchIdempotent(`${base}?offset=-1&format=json`, authed());
    const offset = head.headers.get('stream-next-offset');
    const res = await fetchIdempotent(
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
      // A dependency that stayed unreachable past the retries is this app's
      // upstream problem, not the caller's mistake: say so as 502 rather than
      // letting the throw become an opaque 500.
      console.error('jobs: request failed', error);
      return new Response(`streams unreachable: ${String(error)}`, { status: 502 });
    }
  };
}
