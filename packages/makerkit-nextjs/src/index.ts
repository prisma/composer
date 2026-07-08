/**
 * Marks a service as a Next.js app for deployment. `nextjs({ entry })` says the
 * built standalone server lives at `entry`, relative to the service directory.
 * Returns plain data — nothing runs on import.
 */
import type { BuildAdapter } from '@makerkit/core';

export default (opts: { entry: string }): BuildAdapter => ({ kind: 'nextjs', entry: opts.entry });
