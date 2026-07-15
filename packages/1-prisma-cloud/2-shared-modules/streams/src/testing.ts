/**
 * The local stand-in: `@prisma/streams-local`, the embedded SQLite-only
 * runtime (loopback, no auth, no object store, no cloud credentials) — the
 * same runtime open-chat embeds for local dev. Same Durable Streams protocol
 * surface as the deployed module.
 */
import { startLocalDurableStreamsServer } from '@prisma/streams-local';

export type LocalStreamsServer = Awaited<ReturnType<typeof startLocalDurableStreamsServer>>;

export async function startLocalStreamsServer(opts?: {
  name?: string;
  port?: number;
  hostname?: string;
}): Promise<LocalStreamsServer> {
  // Touch worker threads resolve their module relative to the package's own
  // dist tree, which this bundle does not preserve — same setting the server's
  // local conformance harness uses.
  process.env['DS_TOUCH_WORKERS'] ??= '0';
  return startLocalDurableStreamsServer(opts);
}
