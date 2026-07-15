import { module } from '@prisma/composer';
import { envSecret } from '@prisma/composer-prisma-cloud';
import { storage } from '@prisma/composer-prisma-cloud/storage';
import { streams } from '@prisma/composer-prisma-cloud/streams';

/**
 * The streams example: durable event streams backed by the `storage()`
 * module as its durable tier. The root wires the storage module's `store`
 * port into the streams module's `store` dependency, and binds the streams
 * module's `apiKey` secret slot to a platform variable — secret values never
 * travel through framework config (ADR-0029), so the value is bound here by
 * name only.
 *
 * A closed root: no boundary argument, no return — it only provisions.
 */
export default module('streams-example', ({ provision }) => {
  const store = provision(storage());
  provision(streams(), {
    deps: { store: store.store },
    secrets: { apiKey: envSecret('STREAMS_API_KEY') },
  });
});
