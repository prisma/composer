/**
 * Generates the RPC server from a service's `expose`: a web fetch handler
 * that dispatches `POST /rpc/<method>` across every exposed port, flattened
 * into one method namespace (method names must be unique across a service's
 * ports — there is no port segment in the route). `Handlers<S>` derives the
 * exhaustive, correctly-typed handler map straight off `S["expose"]` and
 * `S["load"]`'s return, so an incomplete or mistyped `serve(service,
 * handlers)` call does not compile; extra handler methods/ports are allowed
 * (width, same as a provider exposing more than a consumer requires).
 *
 * Per ADR-0030, every request is checked against the accepted service-key
 * set before dispatch: unset/empty is the pass-through migration state,
 * a configured non-empty set requires `Authorization: Bearer <key>`.
 */

import type { Contract, Expose, RunnableServiceNode } from '@internal/core';
import { blindCast } from '@internal/foundation/casts';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { standardValidate } from './standard-schema.ts';

// The ambient environment of whatever runtime hosts the bundle. Declared
// structurally so this entry imports no runtime's types.
declare const process: { env: Record<string, string | undefined> };

/** The reserved env var the target (slice 2) writes the accepted key set to. */
export const RPC_ACCEPTED_KEYS_ENV = 'COMPOSER_RPC_ACCEPTED_KEYS';

// biome-ignore lint/suspicious/noExplicitAny: accepts any concrete runnable service node — generics are invariant, so `any` is required (mirrors ModuleBuilder.provision in @prisma/composer).
type AnyRunnable = RunnableServiceNode<any, any, any>;

type CmpOf<C> = C extends Contract<string, infer Cmp> ? Cmp : never;

type HandlerFor<Fn, LoadedDeps> = Fn extends (input: infer I) => Promise<infer O>
  ? (input: I, deps: LoadedDeps) => Promise<O>
  : never;

/** Every exposed port's methods, turned into a handler map typed off S's own `expose` and `load()`. */
export type Handlers<S extends AnyRunnable> = {
  [Port in keyof NonNullable<S['expose']>]: {
    [M in keyof CmpOf<NonNullable<S['expose']>[Port]>]: HandlerFor<
      CmpOf<NonNullable<S['expose']>[Port]>[M],
      ReturnType<S['load']>
    >;
  };
};

interface MethodSchemas {
  readonly input: StandardSchemaV1;
  readonly output: StandardSchemaV1;
}

type RpcHandler = (input: unknown, deps: unknown) => Promise<unknown>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The configured accepted key set, or `[]` if unset/empty/malformed — the pass-through state. */
function acceptedKeys(): readonly string[] {
  const raw = process.env[RPC_ACCEPTED_KEYS_ENV];
  if (raw === undefined || raw === '') return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  return Array.isArray(parsed) && parsed.every((key): key is string => typeof key === 'string')
    ? parsed
    : [];
}

/**
 * Length-independent constant-time string equality — no early exit on the
 * first mismatched character or on a length difference, so a caller cannot
 * time its way toward a valid key. No `node:crypto`, to keep this module
 * runtime-agnostic.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < length; i++) {
    diff |= (i < a.length ? a.charCodeAt(i) : 0) ^ (i < b.length ? b.charCodeAt(i) : 0);
  }
  return diff === 0;
}

/** Whether `presented` is a member of `accepted` — always compares against every key. */
function isAcceptedKey(presented: string, accepted: readonly string[]): boolean {
  let matched = false;
  for (const key of accepted) {
    matched = constantTimeEquals(presented, key) || matched;
  }
  return matched;
}

const BEARER_PREFIX = 'Bearer ';

/** The bearer token on `Authorization`, or `''` if the header is missing or malformed. */
function bearerToken(req: Request): string {
  const header = req.headers.get('authorization');
  return header?.startsWith(BEARER_PREFIX) ? header.slice(BEARER_PREFIX.length) : '';
}

/**
 * Flattens every exposed port's methods into one method → {schemas, handler}
 * table. RPC dispatch is flat (`/rpc/<method>`), so a method name exposed by
 * more than one port is a construction-time error, as is a missing handler.
 */
function methodTable(
  expose: Expose,
  handlers: Record<string, Record<string, RpcHandler>>,
): Map<string, MethodSchemas & { handler: RpcHandler }> {
  const table = new Map<string, MethodSchemas & { handler: RpcHandler }>();

  for (const [port, contract] of Object.entries(expose)) {
    const portHandlers = handlers[port] ?? {};
    for (const [method, fn] of Object.entries(contract.__cmp)) {
      if (table.has(method)) {
        throw new Error(
          `serve(): method "${method}" is exposed by more than one port — RPC dispatch is flat ` +
            "(POST /rpc/<method>), so method names must be unique across a service's exposed ports.",
        );
      }
      const handler = portHandlers[method];
      if (handler === undefined) {
        throw new Error(`serve(): no handler supplied for exposed method "${port}.${method}".`);
      }
      const { input, output } = blindCast<
        MethodSchemas,
        'rpc() stores the method input/output Standard Schemas on the function value; the Cmp type models only the call signature'
      >(fn);
      table.set(method, { input, output, handler });
    }
  }

  return table;
}

/**
 * Routes `POST /rpc/<method>`: parses JSON, validates input, calls the
 * handler with `service.load()`'s deps, validates the output, and responds
 * JSON. An unknown method or invalid input is a 4xx; a handler (or output
 * validation) failure is a 5xx — either way the process does not crash.
 * `load()` is called exactly once, here, before the handler ever runs.
 */
export function serve<S extends AnyRunnable, H extends Handlers<S>>(
  service: S,
  handlers: H,
): (req: Request) => Promise<Response> {
  const table = methodTable(
    service.expose ?? {},
    blindCast<
      Record<string, Record<string, RpcHandler>>,
      'Handlers<S> is the exhaustive typed handler map; methodTable indexes it by the runtime port/method strings'
    >(handlers),
  );
  const deps = service.load();

  return async (req: Request): Promise<Response> => {
    const accepted = acceptedKeys();
    if (accepted.length > 0 && !isAcceptedKey(bearerToken(req), accepted)) {
      return jsonResponse({ error: 'Unauthorized: missing or invalid service key' }, 401);
    }

    const { pathname } = new URL(req.url);
    const methodName = /^\/rpc\/([^/]+)$/.exec(pathname)?.[1];
    if (methodName === undefined) {
      return jsonResponse({ error: `Not found: ${pathname}` }, 404);
    }

    const method = table.get(methodName);
    if (method === undefined) {
      return jsonResponse({ error: `Unknown RPC method "${methodName}"` }, 404);
    }
    if (req.method !== 'POST') {
      return jsonResponse({ error: `Method "${methodName}" requires POST` }, 405);
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: 'Request body must be JSON' }, 400);
    }

    let input: unknown;
    try {
      input = await standardValidate(method.input, body);
    } catch (err) {
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 400);
    }

    try {
      const result = await method.handler(input, deps);
      return jsonResponse(await standardValidate(method.output, result));
    } catch (err) {
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  };
}
