/**
 * The one call edge between the scheduler and the app's router: `trigger(jobId)`.
 * The scheduler depends on it (`rpc(triggerContract)`); the router exposes it
 * (`expose: { trigger: triggerContract }`). `jobId` travels as data through this
 * single method — adding a job never adds a method, service, or port.
 */
import { contract, rpc } from '@prisma/app-rpc';
import { type } from 'arktype';

export const triggerContract = contract({
  trigger: rpc({ input: type({ jobId: 'string' }), output: type({ ok: 'boolean' }) }),
});

export type TriggerContract = typeof triggerContract;
