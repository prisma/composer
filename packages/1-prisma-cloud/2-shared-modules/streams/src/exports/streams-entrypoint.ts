// The boot module the streams service's build points `entry` at. It adapts
// the framework wiring onto `@prisma/streams-server`'s env/argv surface and
// delegates — the runtime (SQLite WAL, segmenting, object-store upload,
// recovery, bearer-key auth) is the production server, unmodified. Deployment
// defaults follow open-chat's production streams app.
import { existsSync } from 'node:fs';
import { STREAMS_API_KEY_ENV } from '@internal/prisma-cloud';
import { streamsService } from './streams-service.ts';

const service = streamsService();

const { store } = service.load();
const { port } = service.config();

// The bearer key is minted per streams module by the target's registered
// provisioner and stashed here as a reserved provider param (ADR-0031/
// ADR-0019); compute's `run` validates and re-stashes it address-free. It
// exists only if at least one consumer declared a `durableStreams()`
// dependency — the need lives on that edge. No consumers means no key, and
// the only thing this server could do without one is serve every endpoint
// unauthenticated. Refuse to boot instead, naming the cause.
const raw = process.env[STREAMS_API_KEY_ENV];
if (raw === undefined || raw === '') {
  throw new Error(
    'streams: no bearer key was provisioned for this module — nothing declares a ' +
      'durableStreams() dependency on it, so the key that authenticates its API was never ' +
      "minted. Wire a consumer to the module's `streams` port, or remove the module.",
  );
}
// The reserved provider param is JSON-encoded, the same wire format any
// service-own literal param takes (ADR-0031) — decode it back to the bearer
// string. Re-checks the decoded shape after parsing, the same way rpc's
// serve() does after its own JSON.parse (serve.ts's acceptedKeys()): a
// malformed or wrongly-shaped stored value fails with the friendly message
// above, not a bare SyntaxError.
let parsed: unknown;
try {
  parsed = JSON.parse(raw);
} catch {
  parsed = undefined;
}
if (typeof parsed !== 'string' || parsed.length === 0) {
  throw new Error(
    'streams: the provisioned bearer key is not a valid JSON-encoded string — the deploy wrote ' +
      'something this entrypoint cannot read back. Redeploy to re-mint the key.',
  );
}
const apiKey = parsed;
process.env['API_KEY'] = apiKey;
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
