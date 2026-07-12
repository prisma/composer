/**
 * The RPC kind's network adapter — the client `rpc(contract)` hydrates to.
 * Reads each method's Standard Schema pair off the contract's `__cmp[method]`
 * runtime value (rpc()'s `{ input, output }`), POSTs JSON to
 * `<url>/rpc/<method>`, and validates the response against the output schema
 * before returning it (a provider can be typed-compatible and still lie at
 * runtime — this is the per-call layer that catches that).
 */

import type { Contract } from '@internal/core';
import { blindCast } from '@internal/foundation/casts';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { Client, RpcFns } from './rpc.ts';
import { standardValidate } from './standard-schema.ts';

/** rpc()'s runtime shape for one method: `{ input, output }` wearing a function's type. */
interface MethodSchemas {
  readonly input: StandardSchemaV1;
  readonly output: StandardSchemaV1;
}

/**
 * A fetch-shaped transport. Defaults to the real `fetch`; a served handler
 * (`serve()`'s return value) works too — the binding does not have to be a
 * network hop.
 */
export type Transport = (req: Request) => Promise<Response>;

/** `<base>/rpc/<method>`, preserving a base URL's own path (e.g. a mount point). */
function methodUrl(base: string, method: string): string {
  const normalizedBase = base.endsWith('/') ? base : `${base}/`;
  return new URL(`rpc/${method}`, normalizedBase).toString();
}

/** The server's `{ error }` body, if the response has one — undefined otherwise. */
async function errorDetail(res: Response): Promise<string | undefined> {
  try {
    const body: unknown = await res.json();
    return typeof body === 'object' && body !== null && 'error' in body
      ? String(body.error)
      : undefined;
  } catch {
    return undefined;
  }
}

export function makeClient<C extends Contract<'rpc', RpcFns>>(
  contract: C,
  url: string,
  opts?: { fetch?: Transport },
): Client<C> {
  const send = opts?.fetch ?? fetch;
  const client: Record<string, (input: unknown) => Promise<unknown>> = {};

  for (const [method, schemas] of Object.entries(
    blindCast<
      Record<string, MethodSchemas>,
      'rpc() stores each method input/output Standard Schemas on the function value; RpcFns types only the call signature'
    >(contract.__cmp),
  )) {
    client[method] = async (input: unknown) => {
      const res = await send(
        new Request(methodUrl(url, method), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        }),
      );
      if (!res.ok) {
        const detail = await errorDetail(res);
        throw new Error(
          `RPC call "${method}" failed: ${res.status} ${res.statusText}` +
            (detail !== undefined ? ` — ${detail}` : ''),
        );
      }
      return standardValidate(schemas.output, await res.json());
    };
  }

  return blindCast<
    Client<C>,
    'client is assembled dynamically from the contract methods; each entry matches Client<C> by construction'
  >(client);
}
