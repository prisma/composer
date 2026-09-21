/**
 * The `auth()` module (spec § Module factory): a dedicated service wrapping
 * Better Auth. The database and the email sender are BOUNDARY dependencies —
 * the root decides dedicated vs shared for the database and wires the email
 * module's `send` port; the instance secret rides the service's `input`
 * document, bound to `generatedParam()` here so the target generates a stable
 * value at deploy and it is invisible to consumers. `baseUrl` is the PUBLIC
 * origin of the consumer app (scheme+host, no trailing slash, no path); roots
 * bind it `envParam('AUTH_BASE_URL')`. `signUp` is a static factory option
 * forwarded into the same input as a literal (email's `deliveryUrl` pattern).
 */
import type { ModuleNode, ParamNeed } from '@internal/core';
import { module, paramNeed } from '@internal/core';
import { emailSender } from '@internal/email';
import { generatedParam } from '@internal/prisma-cloud';
import { authService } from './auth-service.ts';
import {
  authAdminContract,
  authApiContract,
  authDb,
  authSessionContract,
  type SignUpMode,
} from './contract.ts';
import { type AuthTemplates, authTemplates } from './templates.ts';

export interface AuthModuleOptions {
  readonly name?: string;
  /**
   * `'closed'` turns off self-service sign-up (email + password and magic
   * link for unknown emails) inside Better Auth; accounts then come only
   * from `admin.createUser`. Default `'open'`.
   */
  readonly signUp?: SignUpMode;
}

export function auth(opts?: AuthModuleOptions): ModuleNode<
  { db: ReturnType<typeof authDb>; email: ReturnType<typeof emailSender<AuthTemplates>> },
  {
    api: typeof authApiContract;
    session: typeof authSessionContract;
    admin: typeof authAdminContract;
  },
  Record<never, never>,
  { baseUrl: ParamNeed }
> {
  return module(
    opts?.name ?? 'auth',
    {
      deps: { db: authDb(), email: emailSender(authTemplates) },
      params: { baseUrl: paramNeed() },
      expose: {
        api: authApiContract,
        session: authSessionContract,
        admin: authAdminContract,
      },
    },
    ({ inputs, params, provision }) => {
      const service = provision(authService(), {
        id: 'service',
        deps: { db: inputs.db, email: inputs.email },
        input: {
          baseUrl: params.baseUrl,
          secret: generatedParam(),
          signUp: opts?.signUp ?? 'open',
        },
      });
      return { api: service.api, session: service.session, admin: service.admin };
    },
  );
}
