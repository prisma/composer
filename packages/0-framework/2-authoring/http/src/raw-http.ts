import type { Contract, DependencyEnd } from '@internal/core';
import { dependency, string } from '@internal/core';

/** What a `rawHttp()` dependency hydrates to: the provider's URL and a fetch that resolves `path` against it. */
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

/** A dependency on a service that exposes a `rawHttpContract` port. */
export function rawHttp(): DependencyEnd<RawHttpClient, typeof rawHttpContract> {
  return dependency({
    type: 'http',
    connection: {
      params: { url: string() },
      hydrate: ({ url }): RawHttpClient => ({
        url,
        fetch: (path, init) => fetch(new URL(path, url), init),
      }),
    },
    required: rawHttpContract,
  });
}
