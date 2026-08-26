/**
 * Type-level surface (spec § Test plan): the factory shapes (`auth()`'s
 * deps/expose/params), the binding types each dependency hydrates to, the
 * wire record types, and the port-to-slot wiring assignability. Type-only
 * (vitest --typecheck via tsc, never executed) — mirrors email's
 * module.test-d.ts.
 */
import type { DependencyEnd, ModuleNode, ParamNeed, RefPort } from '@internal/core';
import { module, paramSource } from '@internal/core';
import { emailSendContract, type emailSender } from '@internal/email';
import node from '@internal/node';
import { compute, type rawPostgresContract } from '@internal/prisma-cloud';
import type { PostgresContract } from '@internal/prisma-cloud/orm';
import { dataContract, postgres } from '@internal/prisma-cloud/orm';
import { rpc } from '@internal/service-rpc';
import { expectTypeOf, test } from 'vitest';
import { auth } from '../auth-module.ts';
import {
  type AuthApiClient,
  type authAdminContract,
  authApi,
  type authApiContract,
  authDb,
  authSessionContract,
  type JwtVerifier,
  jwtVerifier,
  type SessionRecord,
  type UserRecord,
  type VerifiedSession,
} from '../contract.ts';
import packContractJson from '../pack/contract.json' with { type: 'json' };
import type { AuthTemplates } from '../templates.ts';

const build = node({ module: import.meta.url, entry: '../dist/x.mjs' });

/** A minimal provider of the `email` boundary dep — exposes only `send`, satisfying `emailSender(authTemplates)`'s required contract. */
const mailProvider = () =>
  compute({ name: 'mailProvider', deps: {}, build, expose: { send: emailSendContract } });

test('auth() is a ModuleNode with the db + email boundary deps, three ports, and the baseUrl param need', () => {
  const m = auth();
  const asModule: ModuleNode<
    { db: ReturnType<typeof authDb>; email: ReturnType<typeof emailSender<AuthTemplates>> },
    {
      api: typeof authApiContract;
      session: typeof authSessionContract;
      admin: typeof authAdminContract;
    },
    Record<never, never>,
    { baseUrl: ParamNeed }
  > = m;
  void asModule;
});

test('the dependency factories hydrate to their pinned binding types', () => {
  expectTypeOf(authApi()).toExtend<DependencyEnd<AuthApiClient, typeof authApiContract>>();
  expectTypeOf(jwtVerifier()).toExtend<DependencyEnd<JwtVerifier, typeof authApiContract>>();
  expectTypeOf(authDb()).toExtend<DependencyEnd<{ url: string }, PostgresContract>>();
});

test('a verified session carries the pinned claim projections', () => {
  expectTypeOf<VerifiedSession['userId']>().toEqualTypeOf<string>();
  expectTypeOf<VerifiedSession['sessionId']>().toEqualTypeOf<string>();
  expectTypeOf<VerifiedSession['emailVerified']>().toEqualTypeOf<boolean>();
  expectTypeOf<VerifiedSession['expiresAt']>().toEqualTypeOf<Date>();
  expectTypeOf<VerifiedSession['claims']>().toEqualTypeOf<Record<string, unknown>>();
});

test('the wire records use ISO strings and the banExpiresAt field name', () => {
  expectTypeOf<UserRecord['banExpiresAt']>().toEqualTypeOf<string | null>();
  expectTypeOf<UserRecord['banned']>().toEqualTypeOf<boolean>();
  expectTypeOf<UserRecord['createdAt']>().toEqualTypeOf<string>();
  expectTypeOf<SessionRecord['expiresAt']>().toEqualTypeOf<string>();
  // The bearer token never rides the wire record.
  expectTypeOf<SessionRecord>().not.toHaveProperty('token');
});

test('the module ports wire into their consumer slots; a wrong-kind port is rejected', () => {
  module('root', {}, ({ provision }) => {
    const db = provision(
      postgres({
        name: 'database',
        contract: dataContract(packContractJson),
        config: './prisma.config.ts',
      }),
      { id: 'database' },
    );
    const mail = provision(mailProvider(), { id: 'mail' });
    const identity = provision(auth(), {
      id: 'auth',
      deps: { db, email: mail.send },
      params: { baseUrl: paramSource('AUTH_BASE_URL') },
    });
    provision(
      compute({
        name: 'app',
        deps: { authApi: authApi(), verifier: jwtVerifier(), session: rpc(authSessionContract) },
        build,
      }),
      {
        id: 'app',
        deps: { authApi: identity.api, verifier: identity.api, session: identity.session },
      },
    );
    return {};
  });

  // A postgres port does not satisfy an auth-api slot.
  expectTypeOf<RefPort<typeof rawPostgresContract>>().not.toExtend<
    RefPort<typeof authApiContract>
  >();
});
