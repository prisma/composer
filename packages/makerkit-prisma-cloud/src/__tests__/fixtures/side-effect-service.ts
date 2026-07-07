import { compute, postgres } from '../../index.ts';

// Importing this module must not increment this counter — only calling
// `.run(...)` on the exported node should.
export let handlerCallCount = 0;

export default compute({ db: postgres({ client: ({ url }) => ({ url }) }) }, ({ db }) => {
  handlerCallCount += 1;
  return { db };
});
