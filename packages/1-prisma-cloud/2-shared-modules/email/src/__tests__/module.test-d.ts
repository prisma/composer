/**
 * Type-level wiring for email(): the module's `send`/`outbox` ports are each
 * assignable to their matching consumer slot (`emailSender()`/
 * `rpc(emailOutboxContract)`), and a wrong-kind port is rejected. Type-only
 * (vitest --typecheck, never executed) — mirrors storage's module.test-d.ts.
 */
import type { ModuleNode, ParamNeed, RefPort, SecretNeed } from '@internal/core';
import { module, paramSource, secretSource } from '@internal/core';
import node from '@internal/node';
import { compute, type postgresContract } from '@internal/prisma-cloud';
import { rpc } from '@internal/service-rpc';
import { expectTypeOf, test } from 'vitest';
import { emailOutboxContract, type emailSendContract, emailSender } from '../contract.ts';
import { email } from '../email-module.ts';

const build = node({ module: import.meta.url, entry: '../dist/x.mjs' });

test('email() is a ModuleNode exposing send and outbox ports over module-boundary params/secret', () => {
  const m = email();
  const asModule: ModuleNode<
    Record<never, never>,
    { send: typeof emailSendContract; outbox: typeof emailOutboxContract },
    { deliveryCredential: SecretNeed },
    { deliveryMode: ParamNeed; from: ParamNeed }
  > = m;
  void asModule;
});

test("the module's send port wires into a consumer's emailSender() slot", () => {
  module('root', {}, ({ provision }) => {
    const mail = provision(email(), {
      id: 'email',
      params: { deliveryMode: paramSource('EMAIL_DELIVERY_MODE'), from: paramSource('EMAIL_FROM') },
      secrets: { deliveryCredential: secretSource('EMAIL_DELIVERY_CREDENTIAL') },
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
      params: { deliveryMode: paramSource('EMAIL_DELIVERY_MODE'), from: paramSource('EMAIL_FROM') },
      secrets: { deliveryCredential: secretSource('EMAIL_DELIVERY_CREDENTIAL') },
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
  expectTypeOf<RefPort<typeof postgresContract>>().not.toExtend<typeof emailOutboxContract>();
});
