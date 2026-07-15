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
  images: { unoptimized: true },
  // Next traces native binaries (`sharp`, `@next/swc`) built for THIS
  // machine's platform into the standalone; on Compute's linux VM bun
  // auto-installs their linux variants at boot and fills the tiny disk
  // (ENOSPC crash loop). Exclude them from the trace.
  outputFileTracingExcludes: {
    '*': ['**/node_modules/@next/swc-*/**', '**/node_modules/sharp/**', '**/node_modules/@img/**'],
  },
};

export default nextConfig;
