/**
 * The `auth()` module Loads into a wired graph: the db AND the email sender
 * are BOUNDARY deps the root supplies (dedicated vs shared db, and which
 * email module instance, are the root's call), the instance secret rides the
 * service's `input` document bound to `generatedParam()` inside the factory
 * (consumers see no secret), the `baseUrl` input passes into that same input,
 * and the three ports wire to consumers independently
 * (least-privilege by wiring).
 */
import { describe, expect, test } from 'bun:test';
import { Load, module, type Pointer, type Value } from '@internal/core';
import { emailSendContract } from '@internal/email';
import { rawHttp } from '@internal/http';
import node from '@internal/node';
import {
  compute,
  envParam,
  isGeneratedParamSource,
  isOriginParamSource,
  serviceOrigin,
} from '@internal/prisma-cloud';
import { dataContract, postgres } from '@internal/prisma-cloud/orm';
import { rpc } from '@internal/service-rpc';
import { auth } from '../auth-module.ts';
import { authAdminContract, authSessionContract, jwtVerifier } from '../contract.ts';
import packContractJson from '../pack/contract.json' with { type: 'json' };

const build = node({ module: import.meta.url, entry: '../dist/x.mjs' });

/** The object input binding a root provisioned for one service address (ADR-0042). */
function serviceBindingOf(
  inputBindings: ReadonlyArray<{ serviceAddress: string; binding: unknown }>,
  address = 'root.auth.service',
): Record<string, unknown> {
  const binding = inputBindings.find((b) => b.serviceAddress === address)?.binding;
  if (typeof binding !== 'object' || binding === null || Array.isArray(binding)) {
    throw new Error(`expected an object input binding for ${address}`);
  }
  return binding as Record<string, unknown>;
}

/** A pack-carrying database node — what a root wires into the module's db slot. */
const database = () =>
  postgres({
    name: 'database',
    contract: dataContract(packContractJson),
    config: './prisma.config.ts',
  });

/** A minimal provider of the `email` boundary dep — exposes only `send`, satisfying `emailSender(authTemplates)`'s required contract. */
const mailProvider = () =>
  compute({ name: 'mailProvider', deps: {}, build, expose: { send: emailSendContract } });

const apiConsumer = () =>
  compute({ name: 'apiConsumer', deps: { authApi: rawHttp(), verifier: jwtVerifier() }, build });
const sessionConsumer = () =>
  compute({ name: 'sessionConsumer', deps: { session: rpc(authSessionContract) }, build });
const opsConsumer = () =>
  compute({ name: 'opsConsumer', deps: { admin: rpc(authAdminContract) }, build });

function rootWithAuth(
  baseUrl: Value<string | Pointer<string>> | string = serviceOrigin('root.app'),
) {
  return module('root', {}, ({ provision }) => {
    const db = provision(database(), { id: 'database' });
    const mail = provision(mailProvider(), { id: 'mail' });
    const authRef = provision(auth(), {
      id: 'auth',
      deps: { db, email: mail.send },
      input: { baseUrl },
    });
    provision(apiConsumer(), { id: 'app', deps: { authApi: authRef.api, verifier: authRef.api } });
    provision(sessionConsumer(), { id: 'profile', deps: { session: authRef.session } });
    provision(opsConsumer(), { id: 'ops', deps: { admin: authRef.admin } });
    return {};
  });
}

describe('auth()', () => {
  test('Loads the service with a generated secret in its input; db and email stay boundary deps wired through', () => {
    const graph = Load(rootWithAuth());
    const byId = new Map(graph.nodes.map((n) => [n.id, n.node]));
    const typeOf = (id: string): string | undefined => {
      const n = byId.get(id);
      return n !== undefined && 'type' in n ? n.type : undefined;
    };

    expect(typeOf('root.auth.service')).toBe('compute');
    // The database and the mail provider are the ROOT's nodes — the module
    // provisions no db or email service of its own.
    expect(typeOf('root.database')).toBe('postgres');
    expect(typeOf('root.mail')).toBe('compute');
    expect(graph.edges).toContainEqual({
      from: 'root.database',
      to: 'root.auth.service',
      input: 'db',
      kind: 'dependency',
    });
    expect(graph.edges).toContainEqual({
      from: 'root.mail',
      to: 'root.auth.service',
      input: 'email',
      kind: 'dependency',
    });
    // The instance secret is a `generatedParam()` leaf of the service's input
    // document, bound by the factory — no dedicated secret node exists.
    const binding = serviceBindingOf(graph.inputBindings);
    expect(isGeneratedParamSource(binding['secret'])).toBe(true);
  });

  test("the baseUrl input reaches the service's input: serviceOrigin() as its source", () => {
    const graph = Load(rootWithAuth());
    const binding = serviceBindingOf(graph.inputBindings);
    expect(isOriginParamSource(binding['baseUrl'])).toBe(true);
  });

  test('an envParam() baseUrl reaches the service as its value at deploy', () => {
    const graph = Load(rootWithAuth(envParam('AUTH_BASE_URL')), {
      configPool: { AUTH_BASE_URL: 'https://app.example' },
    });
    expect(serviceBindingOf(graph.inputBindings)['baseUrl']).toBe('https://app.example');
  });

  test('a literal baseUrl reaches the service unchanged', () => {
    const graph = Load(rootWithAuth('https://app.example'));
    expect(serviceBindingOf(graph.inputBindings)['baseUrl']).toBe('https://app.example');
  });

  test("signUp rides the service input as a literal: 'open' by default, 'closed' when asked", () => {
    expect(serviceBindingOf(Load(rootWithAuth()).inputBindings)['signUp']).toBe('open');

    const closedRoot = module('root', {}, ({ provision }) => {
      const db = provision(database(), { id: 'database' });
      const mail = provision(mailProvider(), { id: 'mail' });
      provision(auth({ signUp: 'closed' }), {
        id: 'auth',
        deps: { db, email: mail.send },
        input: { baseUrl: serviceOrigin('root.app') },
      });
      return {};
    });
    expect(serviceBindingOf(Load(closedRoot).inputBindings)['signUp']).toBe('closed');
  });

  test('the three ports wire to three consumers independently', () => {
    const graph = Load(rootWithAuth());
    expect(graph.edges).toContainEqual({
      from: 'root.auth.service',
      to: 'root.app',
      input: 'authApi',
      kind: 'dependency',
    });
    expect(graph.edges).toContainEqual({
      from: 'root.auth.service',
      to: 'root.app',
      input: 'verifier',
      kind: 'dependency',
    });
    expect(graph.edges).toContainEqual({
      from: 'root.auth.service',
      to: 'root.profile',
      input: 'session',
      kind: 'dependency',
    });
    expect(graph.edges).toContainEqual({
      from: 'root.auth.service',
      to: 'root.ops',
      input: 'admin',
      kind: 'dependency',
    });
  });

  test('a custom name scopes the internal ids', () => {
    const graph = Load(
      module('root', {}, ({ provision }) => {
        const db = provision(database(), { id: 'database' });
        const mail = provision(mailProvider(), { id: 'mail' });
        provision(auth({ name: 'identity' }), {
          id: 'identity',
          deps: { db, email: mail.send },
          input: { baseUrl: serviceOrigin('root.app') },
        });
        return {};
      }),
    );
    const ids = graph.nodes.map((n) => n.id);
    expect(ids).toContain('root.identity.service');
    const binding = serviceBindingOf(graph.inputBindings, 'root.identity.service');
    expect(isGeneratedParamSource(binding['secret'])).toBe(true);
  });
});
