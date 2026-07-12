/**
 * Cron as a driver: an always-on scheduler that depends on a single
 * `trigger(jobId)` endpoint and calls it on a timer (ADR-0020). This module is
 * the authoring API — `defineSchedule` + `cronScheduler` + `serveSchedule` +
 * `cron` (the module helper) + the trigger contract. `runScheduler` (the
 * injectable firing loop `cronScheduler`'s entrypoint drives) is exported for
 * tests that need to drive it directly against a real trigger client — see
 * examples/cron's end-to-end firing integration test.
 */
export type { TriggerContract } from './contract.ts';
export { triggerContract } from './contract.ts';
export { cron } from './module.ts';
export type { Schedule } from './schedule.ts';
export { defineSchedule } from './schedule.ts';
export { cronScheduler, runScheduler } from './scheduler.ts';
export { serveSchedule } from './serve-schedule.ts';
