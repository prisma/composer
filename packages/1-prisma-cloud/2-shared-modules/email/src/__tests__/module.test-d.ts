/**
 * Type-level wiring for email(): the module's `send`/`outbox` ports are each
 * assignable to their matching consumer slot (`emailSender()`/
 * `rpc(emailOutboxContract)`), and a wrong-kind port is rejected. Type-only
 * (vitest --typecheck, never executed) — mirrors storage's module.test-d.ts.
 */
import type { ModuleNode, RefPort, SecretString, Value } from '@internal/core';
import { module } from '@internal/core';
import node from '@internal/node';
import { compute, envParam, envSecret, type rawPostgresContract } from '@internal/prisma-cloud';
import { rpc } from '@internal/service-rpc';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { expectTypeOf, test } from 'vitest';
import { emailOutboxContract, type emailSendContract, emailSender } from '../contract.ts';
import { email } from '../email-module.ts';

const build = node({ module: import.meta.url, entry: '../dist/x.mjs' });

test('email() is a ModuleNode exposing send and outbox, with an input schema', () => {
  const m = email();
  const asModule: ModuleNode<
    Record<never, never>,
    { send: typeof emailSendContract; outbox: typeof emailOutboxContract },
    StandardSchemaV1
  > = m;
  void asModule;
});

test("email()'s input is deliveryMode, from and a secret deliveryCredential", () => {
  expectTypeOf<
    StandardSchemaV1.InferInput<NonNullable<ReturnType<typeof email>['inputSchema']>>
  >().toEqualTypeOf<{ deliveryMode: string; from: string; deliveryCredential: SecretString }>();
});

test("the module's send port wires into a consumer's emailSender() slot", () => {
  module('root', {}, ({ provision }) => {
    const mail = provision(email(), {
      id: 'email',
      input: {
        deliveryMode: envParam('EMAIL_DELIVERY_MODE'),
        from: envParam('EMAIL_FROM'),
        deliveryCredential: envSecret('EMAIL_DELIVERY_CREDENTIAL'),
      },
    });
    provision(compute({ name: 'sender', deps: { email: emailSender({}) }, build }), {
      id: 'sender',
      deps: { email: mail.send },
    });
    return {};
  });
});

test("the module's outbox port wires into a consumer's rpc(emailOutboxContract) slot", () => {
  module('root', {}, ({ provision }) => {
    const mail = provision(email(), {
      id: 'email',
      input: {
        deliveryMode: envParam('EMAIL_DELIVERY_MODE'),
        from: envParam('EMAIL_FROM'),
        deliveryCredential: envSecret('EMAIL_DELIVERY_CREDENTIAL'),
      },
    });
    provision(compute({ name: 'reader', deps: { outbox: rpc(emailOutboxContract) }, build }), {
      id: 'reader',
      deps: { outbox: mail.outbox },
    });
    return {};
  });
});

test('the outbox slot accepts an outbox port but rejects a wrong-kind (postgres) one', () => {
  expectTypeOf<RefPort<typeof emailOutboxContract>>().toExtend<typeof emailOutboxContract>();
  expectTypeOf<RefPort<typeof rawPostgresContract>>().not.toExtend<typeof emailOutboxContract>();
});

test("email() needs its input, takes a value of the root's narrower type, and refuses a plain string credential", () => {
  let mode!: Value<'resend' | 'smtp' | 'none'>;
  module('root', {}, ({ provision }) => {
    // @ts-expect-error email() declares an input, so the provision needs one
    provision(email());
    provision(email(), {
      id: 'narrow',
      input: {
        deliveryMode: mode,
        from: envParam('EMAIL_FROM'),
        deliveryCredential: envSecret('EMAIL_DELIVERY_CREDENTIAL'),
      },
    });
    provision(email(), {
      id: 'plain',
      input: {
        deliveryMode: 'none',
        from: 'a@example.com',
        // @ts-expect-error a secret field takes no plain string
        deliveryCredential: 'plain',
      },
    });
    provision(email(), {
      id: 'retired',
      input: {
        deliveryMode: 'none',
        from: 'a@example.com',
        deliveryCredential: envSecret('EMAIL_DELIVERY_CREDENTIAL'),
      },
      // @ts-expect-error a module takes no params map
      params: { from: envParam('EMAIL_FROM') },
    });
    return {};
  });
});
