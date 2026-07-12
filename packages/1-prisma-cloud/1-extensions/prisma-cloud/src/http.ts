import type { DependencyEnd } from '@internal/core';
import { dependency, string } from '@internal/core';

/** A service-to-service dependency's client: a thin URL-anchored fetch wrapper. */
export interface HttpClient {
  readonly url: string;
  fetch(path: string, init?: RequestInit): Promise<Response>;
}

const defaultHttpClient = (cfg: { url: string }): HttpClient => ({
  url: cfg.url,
  fetch: (path, init) => fetch(new URL(path, cfg.url), init),
});

/**
 * A service-to-service dependency. Its binding (what `load()` returns) is a
 * derived HttpClient — a thin URL-anchored fetch wrapper (fetch is standard
 * across runtimes — no driver, no runtime coupling). http() is a
 * protocol-owned kind: the framework owns the transport, so the client is
 * kind-canonical and derived from the contract, with no user client in the
 * declaration (ADR-0015). The typed generated client arrives with the
 * interface primitive (a later extension point).
 */
export const http = (opts: { name: string }): DependencyEnd<HttpClient> =>
  dependency({
    name: opts.name,
    type: 'http',
    connection: {
      params: { url: string() },
      hydrate: (v) => defaultHttpClient({ url: v.url }),
    },
  });
