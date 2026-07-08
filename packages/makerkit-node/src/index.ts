/**
 * Marks a service as a plain server for deployment. `node({ entry })` says the
 * app's built server lives at `entry`, relative to the service directory.
 * Returns plain data — nothing runs on import.
 */
import type { BuildAdapter } from '@makerkit/core';

export default (opts: { entry: string }): BuildAdapter => ({ kind: 'node', entry: opts.entry });
