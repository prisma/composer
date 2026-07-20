// The reusable boot module the storage service's build points `entry` at (see
// storageService's `node({ entry: './storage-entrypoint.mjs' })`). It builds
// its own bare node — the stash keys config by owner+param-name, address-free,
// so a node with the same db/credentials/bucket shape reads the same env keys
// the app's own node wrote (mirrors scheduler-entrypoint.ts). This is where the
// pure engine (D2) and the Postgres store (D3) meet the framework: load() hands
// the deps, config() the params, and the server serves the wire protocol.
import { createPgStore } from '../pg-store.ts';
import { startStorageServer } from '../storage-server.ts';
import { storageService } from '../storage-service.ts';

const service = storageService({ bucket: 'storage' });

const { db, credentials } = service.load();
const { bucket, port } = service.config();

const store = await createPgStore(db.url);
startStorageServer({ store, credentials, bucket, port });
