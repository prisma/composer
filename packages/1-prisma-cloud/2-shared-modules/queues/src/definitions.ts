import type { Type } from 'arktype';

export type QueueDuration = `${number}${'s' | 'm' | 'h'}`;

export interface FixedBackoff {
  readonly kind: 'fixed';
  readonly delaySeconds: number;
}

export interface QueueRetryPolicy {
  readonly maxAttempts?: number;
  readonly delay?: FixedBackoff;
}

export interface QueueDefinition<Message> {
  readonly message: Type<Message>;
  readonly retry?: QueueRetryPolicy;
}

// biome-ignore lint/suspicious/noExplicitAny: a queue catalog is heterogeneous; each key carries its own message type.
export type QueueDefinitions = Record<string, QueueDefinition<any>>;

/** Creates a serializable fixed delay used after every failed delivery attempt. */
export function fixedBackoff(opts: { readonly delay: QueueDuration }): FixedBackoff {
  const match = /^(\d+)(s|m|h)$/.exec(opts.delay);
  if (match === null) {
    throw new Error(
      'fixedBackoff(): delay must use whole seconds, minutes, or hours, for example "30s".',
    );
  }

  const value = Number(match[1] ?? Number.NaN);
  const unit = match[2];
  const multiplier = unit === 'h' ? 3600 : unit === 'm' ? 60 : 1;
  const delaySeconds = value * multiplier;
  if (delaySeconds < 1 || delaySeconds > 86_400) {
    throw new Error('fixedBackoff(): delay must be between 1 second and 24 hours.');
  }

  return Object.freeze({ kind: 'fixed', delaySeconds });
}

/** Defines queue names and their message schemas without provisioning anything. */
export function defineQueues<
  // biome-ignore lint/suspicious/noExplicitAny: the self-referential bound preserves each queue's independent message type.
  const Definitions extends { [Name in keyof Definitions]: QueueDefinition<any> },
>(definitions: Definitions): Definitions {
  const catalog: QueueDefinitions = definitions;
  for (const [queueName, definition] of Object.entries(catalog)) {
    const maxAttempts = definition.retry?.maxAttempts;
    if (
      maxAttempts !== undefined &&
      (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100)
    ) {
      throw new Error(
        `defineQueues(): queue "${queueName}" retry.maxAttempts must be an integer from 1 through 100.`,
      );
    }

    const delay = definition.retry?.delay;
    if (
      delay !== undefined &&
      (delay.kind !== 'fixed' ||
        !Number.isInteger(delay.delaySeconds) ||
        delay.delaySeconds < 1 ||
        delay.delaySeconds > 86_400)
    ) {
      throw new Error(
        `defineQueues(): queue "${queueName}" retry.delay must come from fixedBackoff().`,
      );
    }
  }
  return definitions;
}
