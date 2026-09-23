import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

// Trace workspace dependencies used by the packaged Node server.
const workspaceRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

const nextConfig: NextConfig = {
  outputFileTracingRoot: workspaceRoot,
  images: { unoptimized: true },
  outputFileTracingExcludes: {
    '*': ['**/node_modules/@next/swc-*/**', '**/node_modules/sharp/**', '**/node_modules/@img/**'],
  },
};

export default nextConfig;
