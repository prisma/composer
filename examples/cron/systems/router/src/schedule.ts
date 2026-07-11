/**
 * The one source of truth for this app's cron schedule (ADR-0020): the job
 * ids `serveSchedule` forces a handler for, and the `every` intervals
 * `runScheduler` fires on. Short intervals so the integration test is quick.
 */
import { defineSchedule } from '@prisma/app-cron';

export const schedule = defineSchedule({ tick: '2s', mrr: '5s' });
