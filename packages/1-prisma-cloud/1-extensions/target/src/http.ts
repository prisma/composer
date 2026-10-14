import type { Contract, DependencyEnd } from '@internal/core';
import { dependency, string } from '@internal/core';

/** A service-to-service dependency's client: a thin URL-anchored fetch wrapper. */
export interface HttpClient {
  readonly url: string;
  fetch(path: string, init?: RequestInit): Promise<Response>;
}

/**
 * A service's ordinary HTTP endpoint. Expose this port to wire a reverse proxy,
 * Next.js app or file server without introducing an RPC handler. Kind equality
 * keeps independently loaded copies compatible; this contract states the
 * transport, not the application's routes or an access policy.
 */
export const httpContract: Contract<'http', { readonly url: string }> = Object.freeze({
  kind: 'http',
  __cmp: { url: '' },
  satisfies: (required: Contract<'http', unknown>) => required.kind === 'http',
});

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
export function http(): DependencyEnd<HttpClient, typeof httpContract>;
/**
 * Compatibility with the original untyped dependency. New declarations should
 * use http() and wire an exposed httpContract port; the dependency key names it.
 */
export function http(opts: { name: string }): DependencyEnd<HttpClient>;
export function http(opts?: { name: string }): DependencyEnd<HttpClient> {
  return dependency({
    ...(opts === undefined ? {} : { name: opts.name }),
    type: 'http',
    required: opts === undefined ? httpContract : undefined,
    connection: {
      params: { url: string() },
      hydrate: (v) => defaultHttpClient({ url: v.url }),
    },
  });
}
