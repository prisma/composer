import node from '@prisma/composer/node';
import { compute } from '@prisma/composer-prisma-cloud';
import { durableStreams } from '@prisma/composer-prisma-cloud/streams';

/**
 * The jobs service: a plain HTTP app that appends and reads events, backed by
 * the streams module. Its `events` slot is a `durableStreams()` dependency, so
 * `load()` hands it the `StreamsConfig` — the endpoint URL and the bearer key
 * the deploy minted for this binding (ADR-0031). No secret slot, nothing to
 * bind at the root: declaring the dependency IS what causes the key to exist.
 */
export default compute({
  name: 'jobs',
  deps: { events: durableStreams() },
  build: node({ module: import.meta.url, entry: '../../dist/jobs/server.mjs' }),
});
