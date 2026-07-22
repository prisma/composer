/**
 * `@internal/email`'s authoring surface: the two wire contracts a hydrated
 * consumer talks (`send`, `outbox`), template declarations
 * (`defineTemplates`), and `emailSender(templates)` — the dependency that
 * turns a template map into one typed method per template over the `send`
 * port. Templates render consumer-side (ADR-0005); the wire carries only
 * rendered mail (spec D2).
 */
import type { DependencyEnd } from '@internal/core';
import { dependency, string } from '@internal/core';
import { assertDefined } from '@internal/foundation/assertions';
import { blindCast } from '@internal/foundation/casts';
import { contract, makeClient, perBindingToken, rpc } from '@internal/service-rpc';
import { type Type, type } from 'arktype';

/** What a template's render produces. `text` is optional; `html` is required. */
export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text?: string;
}

/**
 * One template's data schema and its render function. `render` may be
 * synchronous or async — the sender method awaits its result either way, so
 * react-email's/jsx-email's async `render()` works directly (spec's
 * `TemplateDef` amendment, 2026-07-22).
 */
export interface TemplateDef<D> {
  readonly data: Type<D>;
  readonly render: (data: D) => RenderedEmail | Promise<RenderedEmail>;
}

// biome-ignore lint/suspicious/noExplicitAny: width-only bound for a heterogeneous map of TemplateDef<D>, one D per key — matches RpcFns's own `any` bound (service-rpc/src/contract.ts). `never` does not work here: arktype's `Type<D>` carries D in a covariant position internally, so `TemplateDef<never>` rejects every concrete template when checked as a generic constraint or type instantiation.
export type TemplateDefs = Record<string, TemplateDef<any>>;

/**
 * Identity helper that infers `T` with literal keys and each entry's own
 * data type — the `defineSchedule` pattern
 * (`packages/1-prisma-cloud/2-shared-modules/cron/src/schedule.ts`).
 * Performs no validation and no transformation.
 */
export function defineTemplates<
  // biome-ignore lint/suspicious/noExplicitAny: self-referential constraint bound — each key's own TemplateDef<D> is inferred independently; matches contract()'s RpcFns bound (service-rpc/src/contract.ts).
  const T extends { [K in keyof T]: TemplateDef<any> },
>(defs: T): T {
  return defs;
}

const emailStatus = type("'stored'|'queued'|'sent'|'failed'");

const sendInput = type({
  templateId: 'string',
  to: '1<=string[]<=50',
  'cc?': 'string[]',
  'bcc?': 'string[]',
  'replyTo?': 'string',
  subject: 'string',
  html: 'string',
  'text?': 'string',
  idempotencyKey: '1<=string<=256',
});

const sendResult = type({
  id: 'string',
  status: emailStatus,
  'error?': 'string',
});

export const emailSendContract = contract({
  send: rpc({ input: sendInput, output: sendResult }),
});

const emailRecord = type({
  id: 'string',
  templateId: 'string',
  to: 'string[]',
  cc: 'string[]',
  bcc: 'string[]',
  replyTo: 'string | null',
  from: 'string',
  subject: 'string',
  html: 'string',
  text: 'string | null',
  status: emailStatus,
  providerMessageId: 'string | null',
  error: 'string | null',
  attempts: 'number',
  createdAt: 'string',
  updatedAt: 'string',
});

export const emailOutboxContract = contract({
  getEmail: rpc({
    input: type({ id: 'string' }),
    output: type({ email: emailRecord.or('null') }),
  }),
  listEmails: rpc({
    input: type({
      'to?': 'string',
      'templateId?': 'string',
      'status?': emailStatus,
      'cursor?': 'string',
      'limit?': '1<=number.integer<=200',
    }),
    output: type({
      emails: emailRecord.array(),
      'nextCursor?': 'string',
    }),
  }),
});

/**
 * The per-template send methods a `emailSender(templates)` dependency
 * hydrates to. Optional fields accept explicit `undefined` — absent and
 * `undefined` mean the same thing everywhere — so a caller under
 * `exactOptionalPropertyTypes` can pass a maybe-undefined value straight
 * through instead of conditionally spreading it (spec's `EmailSender`
 * amendment, 2026-07-22).
 */
export type EmailSender<T extends TemplateDefs> = {
  readonly [K in keyof T]: (input: {
    readonly to: string | readonly string[];
    readonly data: T[K] extends TemplateDef<infer D> ? D : never;
    readonly cc?: readonly string[] | undefined;
    readonly bcc?: readonly string[] | undefined;
    readonly replyTo?: string | undefined;
    /** Omitted (or `undefined`) mints a fresh UUID on every call — that call's own retry is NOT deduped against a previous one. Supply and reuse your own key across retries to get the outbox's dedup guarantee. */
    readonly idempotencyKey?: string | undefined;
  }) => Promise<{ id: string; status: 'stored' | 'queued' | 'sent' | 'failed'; error?: string }>;
};

/** The shape one dynamically-built sender method has before the final cast to `EmailSender<T>`. */
interface SenderMethodInput {
  readonly to: string | readonly string[];
  readonly data: unknown;
  readonly cc?: readonly string[] | undefined;
  readonly bcc?: readonly string[] | undefined;
  readonly replyTo?: string | undefined;
  readonly idempotencyKey?: string | undefined;
}

/**
 * A consumer's dependency on the `send` port: one method per declared
 * template, each validating its own `data`, rendering, and calling the
 * generic `send` op. Connection params and hydration reuse `rpc()`'s exactly
 * — same `url`/`serviceKey` binding, built the same way `rpc(emailSendContract)`
 * would be, then wrapped.
 */
export function emailSender<T extends TemplateDefs>(
  templates: T,
): DependencyEnd<EmailSender<T>, typeof emailSendContract> {
  return dependency({
    type: 'rpc',
    connection: {
      params: {
        url: string(),
        serviceKey: string({ optional: true, provision: perBindingToken() }),
      },
      hydrate: ({ url, serviceKey }) => {
        const client = makeClient(emailSendContract, url, { serviceKey });
        const sender: Record<string, (input: SenderMethodInput) => ReturnType<typeof client.send>> =
          {};

        for (const templateId of Object.keys(templates)) {
          const def = templates[templateId];
          assertDefined(
            def,
            `email.${templateId}(): unreachable — key came from Object.keys(templates).`,
          );
          sender[templateId] = async (input) => {
            const validated = def.data(input.data);
            if (validated instanceof type.errors) {
              throw new Error(
                `email.${templateId}(): data does not match the template schema: ${validated.summary}`,
              );
            }

            // Validation happens before render, always — and a render that
            // throws or rejects propagates to the caller exactly as a
            // throwing sync render does: no send-op call, no outbox row,
            // since nothing was ever handed to the wire.
            const rendered = await def.render(validated);
            const to = Array.isArray(input.to) ? [...input.to] : [input.to];
            if (to.length === 0) {
              throw new Error(`email.${templateId}(): "to" must contain at least one recipient.`);
            }

            // A caller-supplied key is reused as-is; an omitted one mints a fresh
            // UUID on every call, so THIS call's own retry logic must capture and
            // reuse the key itself to get dedup — the module does not remember it.
            const idempotencyKey = input.idempotencyKey ?? crypto.randomUUID();
            return client.send({
              templateId,
              to,
              ...(input.cc !== undefined ? { cc: [...input.cc] } : {}),
              ...(input.bcc !== undefined ? { bcc: [...input.bcc] } : {}),
              ...(input.replyTo !== undefined ? { replyTo: input.replyTo } : {}),
              ...rendered,
              idempotencyKey,
            });
          };
        }

        return blindCast<
          EmailSender<T>,
          'assembled dynamically from template keys; each entry matches EmailSender<T> by construction, mirroring makeClient (service-rpc/src/client.ts)'
        >(sender);
      },
    },
    required: emailSendContract,
  });
}
