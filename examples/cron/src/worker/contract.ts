/**
 * The worker's public RPC contract — the two jobs the runner's schedule
 * dispatches to. Lives with the service that owns it (mirrors auth's
 * contract.ts); the runner imports it to depend on the worker via
 * `rpc(workerContract)`.
 */
import { contract, rpc } from '@prisma/compose/rpc';
import { type } from 'arktype';

export const workerContract = contract({
  tick: rpc({ input: type({}), output: type({ ok: 'boolean' }) }),
  refreshMrr: rpc({ input: type({}), output: type({ ok: 'boolean' }) }),
});
