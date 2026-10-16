/**
 * Raw HTTP: the untyped tier of service-to-service connections. A provider
 * exposes a `rawHttpContract` port; a consumer declares `rawHttp()` and gets
 * `{ url, fetch }`. The framework checks only that the provider declared an
 * HTTP port. Web-standard fetch only, so it runs on any runtime.
 */

export type { RawHttpClient } from '../raw-http.ts';
export { rawHttp, rawHttpContract } from '../raw-http.ts';
