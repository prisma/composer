import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

// The monorepo root: standalone file tracing must start here, or Next walks up
// to the outer checkout's lockfile and traces the wrong node_modules.
const workspaceRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

// Standalone output is what Prisma Compute deploys — a self-contained server.js
// plus the minimal node_modules, not a `next start` dev server.
const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: workspaceRoot,
};

export default nextConfig;
