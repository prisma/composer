import type { Deps, HydratedDeps, Params, RunnableServiceNode } from '@internal/core';
import { assertDefined } from '@internal/foundation/assertions';
import { blindCast } from '@internal/foundation/casts';
import type { Handlers } from '@internal/service-rpc';
import { serve } from '@internal/service-rpc';
import { type } from 'arktype';
import type { queueConsumerContract } from './contracts.ts';
import type { QueueDefinition, QueueDefinitions } from './definitions.ts';
import type { QueueConsumerMessage } from './types.ts';

type MessageOf<Definition> = Definition extends QueueDefinition<infer Message> ? Message : never;

export type QueueHandlers<Definitions extends QueueDefinitions, LoadedDeps> = {
  readonly [Name in keyof Definitions]: (
    message: QueueConsumerMessage<MessageOf<Definitions[Name]>>,
    deps: LoadedDeps,
  ) => Promise<void>;
};

type UntypedHandler = (message: QueueConsumerMessage<unknown>, deps: unknown) => Promise<void>;

/** Validates a delivered body and routes it to the handler for its queue name. */
export function serveQueues<D extends Deps, P extends Params, Definitions extends QueueDefinitions>(
  service: RunnableServiceNode<D, P, { consumer: typeof queueConsumerContract }>,
  definitions: Definitions,
  handlers: QueueHandlers<Definitions, HydratedDeps<D>>,
): (request: Request) => Promise<Response> {
  const byQueue = blindCast<
    Record<string, UntypedHandler>,
    'the caller supplies an exhaustive handler map keyed by the same queue catalog used for runtime dispatch'
  >(handlers);

  const deliver = async (
    message: QueueConsumerMessage<unknown>,
    deps: HydratedDeps<D>,
  ): Promise<{ ok: boolean }> => {
    const definition = definitions[message.queue];
    const handler = byQueue[message.queue];
    assertDefined(definition, `serveQueues(): unknown queue "${message.queue}".`);
    assertDefined(handler, `serveQueues(): no handler for queue "${message.queue}".`);

    const validated = definition.message(message.body);
    if (validated instanceof type.errors) {
      throw new Error(
        `serveQueues(): message for "${message.queue}" does not match its schema: ${validated.summary}`,
      );
    }
    try {
      await handler({ ...message, body: validated }, deps);
      return { ok: true };
    } catch (error) {
      console.error(
        `queue consumer handler failed for "${message.queue}" message "${message.id}" attempt ${message.attempt}`,
        error,
      );
      return { ok: false };
    }
  };

  return serve(
    service,
    blindCast<
      Handlers<typeof service>,
      'deliver is typed from queueConsumerContract above; the cast only bridges the unresolved generic service projection'
    >({ consumer: { deliver } }),
  );
}
