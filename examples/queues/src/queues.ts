import { defineQueues, fixedBackoff } from '@prisma/composer-prisma-cloud/queues';
import { type } from 'arktype';

export const DEMO_RETRY_DELAY = '5s';
export const DEMO_MAX_ATTEMPTS = 5;

export const demoQueues = defineQueues({
  messages: {
    message: type({ text: '1 <= string <= 2000' }),
    retry: {
      maxAttempts: DEMO_MAX_ATTEMPTS,
      delay: fixedBackoff({ delay: DEMO_RETRY_DELAY }),
    },
  },
});
