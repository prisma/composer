/**
 * Type-level wiring for email(): the module's `send`/`outbox` ports are each
 * assignable to their matching consumer slot (`emailSender()`/
 * `rpc(emailOutboxContract)`), and a wrong-kind port is rejected. Type-only
 * (vitest --typecheck, never executed) — mirrors storage's module.test-d.ts.
 */
import type { ModuleNode, Pointer, RefPort, SecretString, Value } from '@internal/core';
import { appRoot } from '@internal/core';
import node from '@internal/node';
import { compute, type rawPostgresContract, variable } from '@internal/prisma-cloud';
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

test("email()'s input is the wrapped fields deliveryMode and from, and a secret deliveryCredential", () => {
  expectTypeOf<
    StandardSchemaV1.InferInput<NonNullable<ReturnType<typeof email>['inputSchema']>>
  >().toEqualTypeOf<{
    deliveryMode: 'resend' | 'smtp' | 'none' | Pointer<'resend' | 'smtp' | 'none'>;
    from: string | Pointer<string>;
    deliveryCredential: SecretString | Pointer<SecretString>;
  }>();
});

test("the module's send port wires into a consumer's emailSender() slot", () => {
  appRoot('root', ({ provision }) => {
    const from = provision(variable({ name: 'EMAIL_FROM' }));
    const deliveryCredential = provision(variable.secret({ name: 'EMAIL_DELIVERY_CREDENTIAL' }));
    const mail = provision(email(), {
      id: 'email',
      input: {
        deliveryMode: 'none',
        from,
        deliveryCredential,
      },
    });
    provision(compute({ name: 'sender', deps: { email: emailSender({}) }, build }), {
      id: 'sender',
      deps: { email: mail.send },
    });
  });
});

test("the module's outbox port wires into a consumer's rpc(emailOutboxContract) slot", () => {
  appRoot('root', ({ provision }) => {
    const from = provision(variable({ name: 'EMAIL_FROM' }));
    const deliveryCredential = provision(variable.secret({ name: 'EMAIL_DELIVERY_CREDENTIAL' }));
    const mail = provision(email(), {
      id: 'email',
      input: {
        deliveryMode: 'none',
        from,
        deliveryCredential,
      },
    });
    provision(compute({ name: 'reader', deps: { outbox: rpc(emailOutboxContract) }, build }), {
      id: 'reader',
      deps: { outbox: mail.outbox },
    });
  });
});

test('the outbox slot accepts an outbox port but rejects a wrong-kind (postgres) one', () => {
  expectTypeOf<RefPort<typeof emailOutboxContract>>().toExtend<typeof emailOutboxContract>();
  expectTypeOf<RefPort<typeof rawPostgresContract>>().not.toExtend<typeof emailOutboxContract>();
});

test("email() needs its input, takes a value of the root's narrower type, and refuses a plain string credential or a delivery mode that may be any text", () => {
  let mode!: Value<'resend' | 'smtp' | 'none'>;
  appRoot('root', ({ provision }) => {
    const from = provision(variable({ name: 'EMAIL_FROM' }));
    const deliveryCredential = provision(variable.secret({ name: 'EMAIL_DELIVERY_CREDENTIAL' }));
    // @ts-expect-error email() declares an input, so the provision needs one
    provision(email());
    provision(email(), {
      id: 'narrow',
      input: {
        deliveryMode: mode,
        from,
        deliveryCredential,
      },
    });
    provision(email(), {
      id: 'any-text',
      input: {
        // @ts-expect-error a platform variable may hold any text; deliveryMode is resend, smtp or none
        deliveryMode: provision(variable({ name: 'EMAIL_DELIVERY_MODE' })),
        from,
        deliveryCredential,
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
        deliveryCredential,
      },
      // @ts-expect-error a module takes no params map
      params: { from },
    });
  });
});
