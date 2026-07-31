import type { DependencyEnd } from '@internal/core';
import { dependency, string } from '@internal/core';
import { assertDefined } from '@internal/foundation/assertions';
import { blindCast } from '@internal/foundation/casts';
import { contract, makeClient, perBindingToken, rpc } from '@internal/service-rpc';
import { type } from 'arktype';
import type { QueueDefinition, QueueDefinitions } from './definitions.ts';

const unknownValue = type('unknown');
const queueMessage = type({
  id: 'string',
  queue: 'string',
  body: unknownValue,
  attempt: 'number.integer >= 1',
  enqueuedAt: 'string',
});
const queueClaim = type({ message: queueMessage, leaseToken: 'string' }).or({ message: 'null' });

export const queueProducerContract = contract({
  send: rpc({
    input: type({ queue: 'string', body: unknownValue }),
    output: type({ id: 'string' }),
  }),
});

export const queueControlContract = contract({
  claim: rpc({
    input: type({ leaseSeconds: '1 <= number.integer <= 300' }),
    output: queueClaim,
  }),
  complete: rpc({
    input: type({ messageId: 'string', leaseToken: 'string' }),
    output: type({ ok: 'boolean' }),
  }),
  release: rpc({
    input: type({ messageId: 'string', leaseToken: 'string' }),
    output: type({ outcome: type("'retrying' | 'failed' | 'lost'") }),
  }),
});

export const queueConsumerContract = contract({
  deliver: rpc({ input: queueMessage, output: type({ ok: 'boolean' }) }),
});

type MessageOf<Definition> = Definition extends QueueDefinition<infer Message> ? Message : never;

export interface QueueHandle<Message> {
  send(message: Message): Promise<{ id: string }>;
}

export type QueueProducer<Definitions extends QueueDefinitions> = {
  readonly [Name in keyof Definitions]: QueueHandle<MessageOf<Definitions[Name]>>;
};

/** Declares a typed producer dependency with one queue handle per catalog entry. */
export function queueProducer<Definitions extends QueueDefinitions>(
  definitions: Definitions,
): DependencyEnd<QueueProducer<Definitions>, typeof queueProducerContract> {
  return dependency({
    type: 'rpc',
    connection: {
      params: {
        url: string(),
        serviceKey: string({ optional: true, provision: perBindingToken() }),
      },
      hydrate: ({ url, serviceKey }) => {
        const client = makeClient(queueProducerContract, url, { serviceKey });
        const producer: Record<string, QueueHandle<unknown>> = {};

        for (const queueName of Object.keys(definitions)) {
          const definition = definitions[queueName];
          assertDefined(
            definition,
            `queueProducer(): unreachable missing definition for "${queueName}".`,
          );
          producer[queueName] = {
            send: async (message) => {
              const validated = definition.message(message);
              if (validated instanceof type.errors) {
                throw new Error(
                  `queue.${queueName}.send(): message does not match its schema: ${validated.summary}`,
                );
              }
              return client.send({ queue: queueName, body: validated });
            },
          };
        }

        return blindCast<
          QueueProducer<Definitions>,
          'assembled from the literal queue catalog; every handle validates with its own schema before calling the shared producer contract'
        >(producer);
      },
    },
    required: queueProducerContract,
  });
}

/** Declares the consumer port a dispatcher calls. Message typing is applied by serveQueues(). */
export function queueConsumer(): typeof queueConsumerContract {
  return queueConsumerContract;
}
