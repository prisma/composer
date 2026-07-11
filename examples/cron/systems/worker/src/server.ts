// The app's own entrypoint (the build adapter's `entry`) — the pack-printed
// bootstrap dynamically imports this AFTER main.run(address, boot) has
// re-keyed the platform environment address-free, so service.load()/config()
// below read it directly, with no address.

import { serve } from '@prisma/app-rpc';
import service from './service.ts';

const { port } = service.config();

// The trivial target the schedule fires: both jobs just prove they were
// reached (the real work — an ingest job, an MRR refresh, whatever — is the
// app's, not this framework's, concern).
const handler = serve(service, {
  rpc: {
    tick: async () => ({ ok: true }),
    refreshMrr: async () => ({ ok: true }),
  },
});
export default handler;

// Bind all interfaces — Compute routes external HTTP to the VM, so a
// loopback-only listener would be unreachable.
Bun.serve({ port, hostname: '0.0.0.0', fetch: handler });
