/**
 * The `auth()` module: Better Auth in one service. The database and the email
 * sender are dependencies the parent wires. Its input is `baseUrl`, the public
 * origin of the consumer app (scheme and host, no trailing slash, no path),
 * bound with `serviceOrigin('<app>.<service>')`, `envParam(...)` or a literal.
 * The instance secret is a `generatedParam()` the module binds itself; `signUp`
 * is a factory option.
 */
import type { ModuleNode } from '@internal/core';
import { module } from '@internal/core';
import { emailSender } from '@internal/email';
import { rawHttpContract } from '@internal/http';
import { generatedParam } from '@internal/prisma-cloud';
import { type } from 'arktype';
import { authService } from './auth-service.ts';
import { authAdminContract, authDb, authSessionContract, type SignUpMode } from './contract.ts';
import { type AuthTemplates, authTemplates } from './templates.ts';

const authModuleInput = type({ baseUrl: 'string' });

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
    api: typeof rawHttpContract;
    session: typeof authSessionContract;
    admin: typeof authAdminContract;
  },
  typeof authModuleInput
> {
  return module(
    opts?.name ?? 'auth',
    {
      deps: { db: authDb(), email: emailSender(authTemplates) },
      input: authModuleInput,
      expose: {
        api: rawHttpContract,
        session: authSessionContract,
        admin: authAdminContract,
      },
    },
    ({ deps, input, provision }) => {
      const service = provision(authService(), {
        id: 'service',
        deps: { db: deps.db, email: deps.email },
        input: {
          baseUrl: input.baseUrl,
          secret: generatedParam(),
          signUp: opts?.signUp ?? 'open',
        },
      });
      return { api: service.api, session: service.session, admin: service.admin };
    },
  );
}
