import node from '@prisma/composer/node';
import { compute } from '@prisma/composer-prisma-cloud';
import { durableStreams, streamDef, streamsContract } from '@prisma/composer-prisma-cloud/streams';

/** This service's one stream: the job event log. Untyped in this slice — events type as `unknown`. */
export const jobLog = streamsContract({ jobs: streamDef() });

/**
 * The jobs service: a plain HTTP app that appends and reads events, backed by
 * the streams module. Its `events` slot is a `durableStreams(jobLog)`
 * dependency, so `load()` hands it one handle per declared stream — here,
 * `events.jobs` — already owning the name, the create-on-first-use, and the
 * 404 heal. The wire binding underneath carries the endpoint URL and the
 * bearer key the deploy minted for it (ADR-0031); no secret slot, nothing to
 * bind at the root — declaring the dependency IS what causes the key to
 * exist.
 */
export default compute({
  name: 'jobs',
  deps: { events: durableStreams(jobLog) },
  build: node({ module: import.meta.url, entry: '../../dist/jobs/server.mjs' }),
});
