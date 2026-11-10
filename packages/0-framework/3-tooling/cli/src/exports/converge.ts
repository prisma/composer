/** The in-process converge the CLI loads from the app's install. Not public API: published as `@prisma/composer/internal/converge`, it may change in any release. */
export { lower } from '@internal/core/deploy';
export type {
  Converge,
  ConvergeEvent,
  ConvergeFailureReason,
  ConvergeOutcome,
  ConvergeRequest,
  LoweredStack,
} from '../converge-in-process.ts';
export { convergeInProcess } from '../converge-in-process.ts';
