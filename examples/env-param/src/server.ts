// The app's own entrypoint (the build adapter's `entry`) — the pack-printed
// bootstrap dynamically imports this AFTER main.run(address, boot) has
// re-keyed the platform environment address-free, so service.config() below
// reads it directly, with no address.
//
// The build emits this file into dist/server/ next to assets/, and the build
// adapter's directory form ships that whole tree — so the asset is this
// module's sibling in the artifact too, and resolving it against
// import.meta.url works there exactly as it does locally.

import service from './service.ts';

const { greeting, port } = service.config();

const logo = Bun.file(new URL('./assets/logo.svg', import.meta.url));

const handler = async (request: Request): Promise<Response> => {
  if (new URL(request.url).pathname !== '/logo.svg') {
    // The live proof for the param: the env-sourced value, read through
    // config() at runtime — schema-validated, unredacted.
    return Response.json({ greeting });
  }
  // The live proof for the build: a file that only exists here if the whole
  // built directory arrived, not just the entry. Missing means the tree was
  // not copied — say which, rather than serving an opaque 500.
  if (!(await logo.exists())) {
    return new Response('assets/logo.svg is missing beside the entry in the deployed tree', {
      status: 500,
    });
  }
  return new Response(logo);
};

// Bind all interfaces — Compute routes external HTTP to the VM, so a
// loopback-only listener would be unreachable.
Bun.serve({ port, hostname: '0.0.0.0', fetch: handler });
