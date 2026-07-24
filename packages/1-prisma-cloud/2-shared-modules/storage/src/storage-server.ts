/**
 * Boots the S3 wire protocol on `Bun.serve` — the D2 handler over any
 * `ObjectStore`. Binds all interfaces (Compute routes external HTTP to the VM,
 * so a loopback-only listener would be unreachable). Installs the FT-5219
 * process guards so an idle Bun.SQL connection close surfaces as a logged
 * error instead of crash-looping the process on scale-to-zero.
 *
 * Runtime engine code; NOT re-exported from the authoring barrel. The D4
 * entrypoint reads deps via `load()` and calls this.
 */
import type { Credentials, ObjectStore } from '@internal/s3-protocol';
import { createS3Handler } from '@internal/s3-protocol';

export interface StorageServer {
  /** The externally reachable base URL of the running server. */
  readonly url: string;
  stop(): void;
}

export interface StorageServerOptions {
  readonly store: ObjectStore;
  readonly credentials: Credentials;
  /** The module's canonical bucket — surfaced to consumers; the wire namespaces by the path bucket. */
  readonly bucket: string;
  readonly port: number;
  readonly hostname?: string;
}

let guardsInstalled = false;

/** FT-5219: keep the process alive when Bun.SQL surfaces an idle-close as an unawaited async error. Installed once. */
function installProcessGuards(): void {
  if (guardsInstalled) return;
  guardsInstalled = true;
  process.on('uncaughtException', (err) => console.error('uncaughtException', err));
  process.on('unhandledRejection', (err) => console.error('unhandledRejection', err));
}

export function startStorageServer(opts: StorageServerOptions): StorageServer {
  installProcessGuards();
  const handler = createS3Handler({ store: opts.store, credentials: opts.credentials });
  const hostname = opts.hostname ?? '0.0.0.0';
  const server = Bun.serve({ port: opts.port, hostname, fetch: (req) => handler(req) });
  const host = hostname === '0.0.0.0' ? '127.0.0.1' : hostname;
  return {
    url: `http://${host}:${server.port}`,
    stop: () => server.stop(true),
  };
}
