/**
 * The local stand-in: boots `handlers.ts` over the in-memory store with
 * `deliveryMode: 'none'`, loopback only, no auth (`serve()`'s accepted-keys
 * pass-through when the env set is absent — the same as any un-deployed
 * service). `serve()` needs a service node with the right `expose`, so this
 * wraps a bare `compute()` whose `build` is inert (never assembled or
 * deployed) — mirrors the auth module's test fake
 * (`examples/storefront-auth/modules/auth/testing/fake.ts`), promoted here
 * to the module's own official local-dev surface.
 */

import node from '@internal/node';
import { compute } from '@internal/prisma-cloud';
import { serve } from '@internal/service-rpc';
import { emailOutboxContract, emailSendContract } from '../contract.ts';
import { noneDelivery } from '../delivery.ts';
import { createHandlers } from '../handlers.ts';
import { createMemoryOutboxStore } from '../memory-outbox-store.ts';

export interface LocalEmailServer {
  readonly url: string;
  stop(): Promise<void>;
}

export async function startLocalEmailServer(opts?: { port?: number }): Promise<LocalEmailServer> {
  const localService = compute({
    name: 'emailLocal',
    deps: {},
    build: node({ module: import.meta.url, entry: 'testing.ts' }),
    expose: { send: emailSendContract, outbox: emailOutboxContract },
  });

  const handlers = createHandlers({
    store: createMemoryOutboxStore(),
    delivery: noneDelivery,
    deliveryMode: 'none',
    from: 'local@example.com',
  });

  const fetchHandler = serve(localService, {
    send: { send: handlers.send },
    outbox: { getEmail: handlers.getEmail, listEmails: handlers.listEmails },
  });

  const server = Bun.serve({ port: opts?.port ?? 0, hostname: '127.0.0.1', fetch: fetchHandler });
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: async () => {
      server.stop(true);
    },
  };
}
