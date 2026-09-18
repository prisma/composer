/**
 * `startLocalAuthServer`: the module's official local-dev surface — real
 * Better Auth + the real DB-direct handlers against a caller-supplied local
 * Postgres, composed through the SAME fetch topology as the deployed
 * entrypoint. No cloud credentials: the schema arrives through the real PN
 * dbInit path at boot (`ensureLocalAuthSchema` — marker-signed, no-op when
 * already at head), the secret is a fixed dev value, and serve() runs in
 * its no-keys pass-through (nothing provisioned the accepted-keys env).
 *
 * Email: by default a local in-memory sender renders through the real
 * `authTemplates` and captures the result into `capturedEmails`, so a local
 * flow can read its live verification/reset/magic links with no other
 * service running. Supplying `email` — e.g. `emailSender(authTemplates)`
 * hydrated against the email module's own `startLocalEmailServer()` —
 * replaces the capture with the SAME outbox-readback path production uses;
 * `capturedEmails` then stays empty.
 */
import type { EmailSender } from '@internal/email';
import node from '@internal/node';
import { compute } from '@internal/prisma-cloud';
import { serve } from '@internal/service-rpc';
import { composeServiceFetch } from '@internal/service-rpc/compose-fetch';
import { betterAuth } from 'better-auth';
import { buildAuthOptions } from '../auth-options.ts';
import {
  authAdminContract,
  authApiContract,
  authSessionContract,
  type SignUpMode,
} from '../contract.ts';
import { createAuthHandlers } from '../handlers.ts';
import { createPgAuthStore } from '../pg-auth-store.ts';
import { type AuthTemplates, authTemplates } from '../templates.ts';
import { ensureLocalAuthSchema } from './local-schema.ts';

/** One captured email touchpoint — `url` is the live link (verification/reset/magic). */
export interface CapturedAuthEmail {
  readonly template: keyof AuthTemplates;
  readonly to: string;
  readonly url: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export interface LocalAuthServer {
  /** `http://127.0.0.1:<port>` */
  readonly url: string;
  /** Append-only; empty when a custom `email` sender was supplied. */
  readonly capturedEmails: readonly CapturedAuthEmail[];
  stop(): Promise<void>;
}

const LOCAL_DEV_SECRET = 'auth-local-dev-secret-not-for-production!';

/** One template method of the default local sender: renders for real, captures the result, never touches a network. */
function capturingMethod(captured: CapturedAuthEmail[], template: keyof AuthTemplates) {
  return async (input: {
    readonly to: string | readonly string[];
    readonly data: { url: string; appName: string };
  }): Promise<{ id: string; status: 'sent' }> => {
    const rendered = await authTemplates[template].render(input.data);
    captured.push({
      template,
      to: Array.isArray(input.to) ? (input.to[0] ?? '') : input.to,
      url: input.data.url,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text ?? '',
    });
    return { id: crypto.randomUUID(), status: 'sent' };
  };
}

function createCapturingSender(captured: CapturedAuthEmail[]): EmailSender<AuthTemplates> {
  return {
    verification: capturingMethod(captured, 'verification'),
    passwordReset: capturingMethod(captured, 'passwordReset'),
    magicLink: capturingMethod(captured, 'magicLink'),
  };
}

export async function startLocalAuthServer(opts: {
  /** A caller-supplied local Postgres (e.g. `prisma dev`). */
  databaseUrl: string;
  /** Default 0 — an ephemeral port. */
  port?: number;
  /** Default: the server's own URL. */
  baseUrl?: string;
  /** Default: a local sender that renders through `authTemplates` and captures into `capturedEmails`. */
  email?: EmailSender<AuthTemplates>;
  /** Default `'open'`; `'closed'` is the invite-only posture (`auth({ signUp: 'closed' })`). */
  signUp?: SignUpMode;
}): Promise<LocalAuthServer> {
  // The real deploy path in miniature: PN dbInit with the auth pack against
  // the caller's database (no-op off the signed marker on repeat boots).
  await ensureLocalAuthSchema(opts.databaseUrl);

  const capturedEmails: CapturedAuthEmail[] = [];
  const email = opts.email ?? createCapturingSender(capturedEmails);

  // serve() needs a service node with the right `expose`; this bare
  // compute()'s build is inert (never assembled or deployed) — email's
  // local-server pattern. The non-rpc `api` port rides along and is
  // skipped, exactly as on the deployed service.
  const localService = compute({
    name: 'authLocal',
    deps: {},
    build: node({ module: import.meta.url, entry: 'testing.ts' }),
    expose: { api: authApiContract, session: authSessionContract, admin: authAdminContract },
  });
  const handlers = createAuthHandlers(createPgAuthStore(opts.databaseUrl));
  const rpcHandler = serve(localService, {
    session: handlers.session,
    admin: handlers.admin,
  });

  // baseUrl defaults to the server's own URL, which needs the bound port —
  // so listen first with a late-bound handler, then compose.
  let fetchHandler: ((request: Request) => Promise<Response>) | undefined;
  const server = Bun.serve({
    port: opts.port ?? 0,
    hostname: '127.0.0.1',
    fetch: (request) => {
      if (fetchHandler === undefined) {
        return new Response('local auth server still booting', { status: 503 });
      }
      return fetchHandler(request);
    },
  });
  const url = `http://127.0.0.1:${server.port}`;

  const auth = betterAuth(
    buildAuthOptions({
      databaseUrl: opts.databaseUrl,
      secret: LOCAL_DEV_SECRET,
      baseUrl: opts.baseUrl ?? url,
      email,
      signUp: opts.signUp ?? 'open',
    }),
  );
  fetchHandler = composeServiceFetch({
    rpcHandler,
    publicHandler: { pathPrefix: '/api/auth', handler: auth.handler },
  });

  return {
    url,
    capturedEmails,
    stop: async () => {
      server.stop(true);
    },
  };
}
