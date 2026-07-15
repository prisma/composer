// The boot module the streams service's build points `entry` at. It adapts
// the framework wiring onto `@prisma/streams-server`'s env/argv surface and
// delegates — the runtime (SQLite WAL, segmenting, object-store upload,
// recovery, bearer-key auth) is the production server, unmodified. Deployment
// defaults follow open-chat's production streams app.
import { existsSync } from 'node:fs';
import { streamsService } from './streams-service.ts';

const service = streamsService();

const { store } = service.load();
const { apiKey } = service.secrets();
const { port } = service.config();

process.env['API_KEY'] = apiKey.expose();
process.env['PORT'] = String(port);
// Bind beyond loopback so the Compute router can reach the server.
process.env['DS_HOST'] ??= '0.0.0.0';
// The container home dir has almost no writable space; keep the hot tier on
// /tmp — the object store is the durable tier, so losing /tmp is expected.
process.env['DS_ROOT'] ??= '/tmp/ds-data';
// By default segments seal only at 16 MB or 100k rows, which a low-volume app
// may never reach — events would wait in the local WAL indefinitely and die
// with the instance. Sealing at least every 5s bounds that loss window.
process.env['DS_SEGMENT_MAX_INTERVAL_MS'] ??= '5000';
// The storage module caps objects at ~16 MiB; the server's 16 MiB segment
// default sits exactly on it. Seal at half.
process.env['DS_SEGMENT_MAX_BYTES'] ??= '8388608';
process.env['DS_OBJECTSTORE_TIMEOUT_MS'] ??= '60000';
// Touch worker threads resolve their module relative to the source tree and
// cannot spawn from this single-file bundle. 0 matches the server's own
// conformance harness; the segmenter already defaults to in-process.
process.env['DS_TOUCH_WORKERS'] ??= '0';

// The server's object-store client is SigV4 over PUT/GET(range)/HEAD/DELETE/
// ListObjectsV2, path-style — exactly the storage module's supported subset.
process.env['DURABLE_STREAMS_R2_BUCKET'] = store.bucket;
process.env['DURABLE_STREAMS_R2_ENDPOINT'] = store.url;
// Unused when ENDPOINT is set, but the server requires it non-empty.
process.env['DURABLE_STREAMS_R2_ACCOUNT_ID'] ??= 'prisma-composer';
process.env['DURABLE_STREAMS_R2_ACCESS_KEY_ID'] = store.accessKeyId;
process.env['DURABLE_STREAMS_R2_SECRET_ACCESS_KEY'] = store.secretAccessKey;

process.argv.push('--auth-strategy', 'api-key');
// Rehydrate from the store only when the disk is fresh (new instance). On a
// warm restart the local WAL may hold rows not yet uploaded; bootstrap clears
// local state first, so running it unconditionally would drop them.
if (!existsSync(`${process.env['DS_ROOT']}/wal.sqlite`)) {
  console.log('streams: bootstrapping local state from the object store');
  process.argv.push('--bootstrap-from-r2');
}

await import('@prisma/streams-server/compute');
