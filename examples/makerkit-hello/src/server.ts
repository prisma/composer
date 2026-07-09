// The app's own entrypoint (the build adapter's `entry`) — the pack-printed
// bootstrap dynamically imports this AFTER main.run(address, boot) has re-keyed
// the platform environment address-free, so service.load() below reads it
// directly, with no address.
import service from './service.ts';

const { db, port } = service.load();

Bun.serve({
  port,
  hostname: '0.0.0.0',
  fetch: async () => Response.json(await db`select 1 as ok`),
});
