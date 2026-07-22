/**
 * `defineTemplates`'s literal-key inference and `EmailSender<T>`'s
 * per-template method typing (spec D3): the client's shape comes straight
 * off the template declarations, with no annotation at the call site, and a
 * wrong `data` shape must not compile.
 *
 * Type-only (checked by `tsc --noEmit`, never executed) — mirrors
 * service-rpc's serve-handlers.test-d.ts.
 */
import type { DependencyEnd, Hydrated } from '@internal/core';
import { type } from 'arktype';
import { expectTypeOf, test } from 'vitest';
import type { EmailSender } from '../contract.ts';
import { defineTemplates, type emailSendContract, emailSender } from '../contract.ts';

test('defineTemplates infers literal keys and each entry keeps its own data type — no annotation needed', () => {
  const templates = defineTemplates({
    verification: {
      data: type({ link: 'string' }),
      render: ({ link }: { link: string }) => ({ subject: 'Verify', html: link }),
    },
    welcome: {
      data: type({ name: 'string' }),
      render: ({ name }: { name: string }) => ({ subject: 'Welcome', html: name }),
    },
  });

  expectTypeOf(templates.verification.data.infer).toEqualTypeOf<{ link: string }>();
  expectTypeOf(templates.welcome.data.infer).toEqualTypeOf<{ name: string }>();
});

const templates = defineTemplates({
  verification: {
    data: type({ link: 'string' }),
    render: ({ link }) => ({ subject: 'Verify your email', html: `<a href="${link}">Verify</a>` }),
  },
});

const dep = emailSender(templates);

test('emailSender(templates) yields a dependency requiring emailSendContract', () => {
  expectTypeOf(dep).toEqualTypeOf<
    DependencyEnd<EmailSender<typeof templates>, typeof emailSendContract>
  >();
});

test('the hydrated sender has one method per declared template', () => {
  type Sender = Hydrated<typeof dep>;
  expectTypeOf<keyof Sender>().toEqualTypeOf<'verification'>();
});

test('a method call accepts the template’s own data shape and rejects a mismatched one', () => {
  const sender: EmailSender<typeof templates> = emailSender(templates) as unknown as EmailSender<
    typeof templates
  >;

  sender.verification({ to: 'user@example.com', data: { link: 'https://example.com' } });
  sender.verification({ to: ['a@example.com', 'b@example.com'], data: { link: 'x' } });

  // @ts-expect-error "data" must match the verification template's schema ({ link: string })
  sender.verification({ to: 'user@example.com', data: { wrong: 1 } });

  // @ts-expect-error "data" is required
  sender.verification({ to: 'user@example.com' });

  // @ts-expect-error "to" is required
  sender.verification({ data: { link: 'x' } });
});

test('optional fields accept a maybe-undefined value directly — no conditional spread required under exactOptionalPropertyTypes', () => {
  const sender: EmailSender<typeof templates> = emailSender(templates) as unknown as EmailSender<
    typeof templates
  >;
  const maybeIdempotencyKey: string | undefined = undefined;
  const maybeCc: readonly string[] | undefined = undefined;
  const maybeBcc: readonly string[] | undefined = undefined;
  const maybeReplyTo: string | undefined = undefined;

  sender.verification({
    to: 'user@example.com',
    data: { link: 'x' },
    idempotencyKey: maybeIdempotencyKey,
    cc: maybeCc,
    bcc: maybeBcc,
    replyTo: maybeReplyTo,
  });
});

test('render may be async — defineTemplates accepts it and the data type is unaffected', () => {
  const asyncTemplates = defineTemplates({
    welcome: {
      data: type({ name: 'string' }),
      render: async ({ name }: { name: string }) => ({ subject: 'Welcome', html: name }),
    },
  });

  expectTypeOf(asyncTemplates.welcome.data.infer).toEqualTypeOf<{ name: string }>();

  const sender: EmailSender<typeof asyncTemplates> = emailSender(
    asyncTemplates,
  ) as unknown as EmailSender<typeof asyncTemplates>;
  sender.welcome({ to: 'user@example.com', data: { name: 'Ada' } });
});

test('emailSender accepts a directly-built template map with no defineTemplates() wrapper', () => {
  emailSender({
    verification: {
      data: type({ link: 'string' }),
      render: ({ link }: { link: string }) => ({ subject: 'x', html: link }),
    },
  });
});
