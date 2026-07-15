import { module } from '@prisma/composer';
import { storage } from '@prisma/composer-prisma-cloud/storage';
import { streams } from '@prisma/composer-prisma-cloud/streams';

/**
 * The streams example: durable event streams backed by the `storage()`
 * module as its durable tier. The root wires the storage module's `store`
 * port into the streams module's `store` dependency. The bearer key is
 * minted at deploy inside the streams module (ADR-0030) and delivered to
 * consumers through the `streams` binding — nothing to bind here.
 *
 * A closed root: no boundary argument, no return — it only provisions.
 */
export default module('streams-example', ({ provision }) => {
  const store = provision(storage());
  provision(streams(), { deps: { store: store.store } });
});
