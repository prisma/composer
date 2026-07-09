import { hex } from '@makerkit/core';
import { postgres } from '@makerkit/prisma-cloud';
import helloService from './service.ts';

/**
 * The app root: one hex owning its one Postgres. The hex provisions `db` and
 * wires it into the service's `db` slot — the database exists because the hex
 * says so, never because a service mentioned it.
 */
export default hex('hello', (h) => {
  const db = h.provision('db', postgres({ name: 'db' }));
  h.provision('hello', helloService, { db });
});
