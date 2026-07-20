/**
 * The Durable Streams conformance suite against a DEPLOYED streams module.
 * The suite has no auth option, so the harness wraps global fetch to inject
 * the bearer key on every request to the target.
 *
 *   CONFORMANCE_TEST_URL=https://… STREAMS_API_KEY=… \
 *     pnpm vitest run -c vitest.conformance.deployed.config.ts
 *
 * STREAMS_API_KEY carries the deploy-minted bearer key — the harness-only
 * route is reading it from deploy state, where it is stable. Pass the bare
 * key: if you copied it out of the Compute console's
 * `COMPOSER_<ADDR>_STREAMS_API_KEY` var, strip the surrounding quotes first —
 * the stored row is JSON-encoded (ADR-0031).
 *
 * The suite is pinned to exact 0.2.3: later versions (0.3.x) test features
 * @prisma/streams-server 0.1.11 does not ship, so a floating range fails
 * conformance for reasons unrelated to this module.
 */
import { runConformanceTests } from '@durable-streams/server-conformance-tests';

const baseUrl = process.env['CONFORMANCE_TEST_URL']?.replace(/\/$/, '');
if (baseUrl === undefined || baseUrl === '') {
  throw new Error('CONFORMANCE_TEST_URL must point at the deployed streams module');
}
const apiKey = process.env['STREAMS_API_KEY'];
if (apiKey === undefined || apiKey === '') {
  throw new Error('STREAMS_API_KEY must carry the bearer key the deploy bound');
}

const bareFetch = globalThis.fetch;
const authedFetch: typeof fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith(baseUrl)) return bareFetch(input, init);
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : {}));
  if (!headers.has('authorization')) headers.set('authorization', `Bearer ${apiKey}`);
  return bareFetch(input, { ...init, headers });
};
globalThis.fetch = authedFetch;

runConformanceTests({ baseUrl, longPollTimeoutMs: 30_000 });
