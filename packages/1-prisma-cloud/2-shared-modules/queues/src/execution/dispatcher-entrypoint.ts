import { queueDispatcher } from '../dispatcher-service.ts';
import { runDispatcher } from './dispatcher.ts';

const service = queueDispatcher();
const clients = service.load();
const input = service.input();

console.info(`queue dispatcher ready with a ${input.pollIntervalMs}ms poll interval`);
runDispatcher(clients, input);
