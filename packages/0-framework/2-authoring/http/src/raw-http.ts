import type { Contract, DependencyEnd } from '@internal/core';
import { dependency, string } from '@internal/core';

/** What a `rawHttp()` dependency hydrates to: the provider's URL and a fetch that resolves `path` against it and refuses any path that leaves the provider's origin. */
export interface RawHttpClient {
  readonly url: string;
  fetch(path: string, init?: RequestInit): Promise<Response>;
}

/**
 * A port that answers HTTP. It promises nothing about routes, methods or
 * headers, and it declares no communication style. Any port declared with it
 * fills any `rawHttp()` slot.
 */
export const rawHttpContract: Contract<'http', { readonly url: string }> = Object.freeze({
  kind: 'http',
  __cmp: { url: '' },
  satisfies: (required: Contract<'http', unknown>) => required.kind === 'http',
});

function resolveOnProvider(path: string, url: string): URL {
  const target = new URL(path, url);
  const origin = new URL(url).origin;
  if (target.origin !== origin) {
    throw new Error(
      `rawHttp(): path "${path}" resolves to ${target.origin}, not the provider's origin ${origin}.`,
    );
  }
  return target;
}

/** A dependency on a service that exposes a `rawHttpContract` port. */
export function rawHttp(): DependencyEnd<RawHttpClient, typeof rawHttpContract> {
  return dependency({
    type: 'http',
    connection: {
      params: { url: string() },
      hydrate: ({ url }): RawHttpClient => ({
        url,
        fetch: async (path, init) => fetch(resolveOnProvider(path, url), init),
      }),
    },
    required: rawHttpContract,
  });
}
