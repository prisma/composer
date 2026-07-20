import { module } from '@prisma/composer';
import { storage } from '@prisma/composer-prisma-cloud/storage';
import { streams } from '@prisma/composer-prisma-cloud/streams';
import jobsService from './src/jobs/service.ts';

/**
 * The streams example: durable event streams backed by the `storage()` module
 * as its durable tier, plus a `jobs` app that consumes them. The root wires
 * the storage module's `store` port into the streams module's `store`
 * dependency, and the streams module's `streams` port into the jobs service's
 * `events` slot.
 *
 * Nothing here mentions the bearer key: the `events` binding declares it as a
 * provisioning need, so the deploy mints one key for the streams module and
 * writes it to both ends (ADR-0031).
 *
 * A closed root: no boundary argument, no return — it only provisions.
 */
export default module('streams-example', ({ provision }) => {
  const store = provision(storage());
  const events = provision(streams(), { deps: { store: store.store } });
  provision(jobsService, { deps: { events: events.streams } });
});
