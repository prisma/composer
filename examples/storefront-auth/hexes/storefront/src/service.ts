import { compute } from '@makerkit/prisma-cloud';

// The framework-as-Output-adapter shape: this service's handler boots Next's
// standalone server, which owns its own listener (Next reads PORT itself, and
// the page reads AUTH_URL from the VM env — the documented Connection/use()
// gap, hand-wired in alchemy.run.ts until the Connection primitive lands).
// No db input: nothing in the storefront queries its own database today (D3).

// Kept non-literal so neither tsc nor the bundler resolves it at build time;
// the artifact places the bundled main entry next to Next's server.js (see
// scripts/bundle-next.ts), so the relative specifier resolves inside the tar.
const serverModule = './server.js';

export default compute({}, () => import(serverModule));
