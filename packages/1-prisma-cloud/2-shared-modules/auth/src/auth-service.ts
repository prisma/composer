/**
 * The auth compute service (spec § Service): the pack-carrying `db`
 * dependency, the `email` boundary dependency (real verification, reset and
 * magic-link delivery), and one `input` document (ADR-0041/ADR-0042) carrying
 * the public `baseUrl` (the consumer app's origin — what browsers see and
 * `trustedOrigins` allows), the instance `secret` (a redacting box; the
 * module binds it to `generatedParam()`, so the target generates a stable
 * value at deploy and nobody ever supplies one), and the `signUp` mode (a
 * literal the module factory forwards). The three exposed ports are
 * backed by one process. Build/entry mechanics copied from email's service
 * file: `build.module` points at this file's own built output so the deploy
 * bootstrap can re-import it as `main`; `entry` resolves the sibling
 * entrypoint pass in the same dist directory.
 */
import { emailSender } from '@internal/email';
import { secretString } from '@internal/foundation/arktype';
import node from '@internal/node';
import { compute } from '@internal/prisma-cloud';
import { type } from 'arktype';
import { authAdminContract, authApiContract, authDb, authSessionContract } from './contract.ts';
import { authTemplates } from './templates.ts';

export function authService() {
  return compute({
    name: 'auth',
    deps: { db: authDb(), email: emailSender(authTemplates) },
    // `secret` is Better Auth's own option name for the instance secret —
    // local vocabulary, not framework vocabulary; `secretString()` IS the
    // redaction facet in an ADR-0041 schema (boot hands the field a redacting
    // box). `port` stays compute()'s RESERVED service param — the entrypoint
    // reads it from `service.port()`, never the input.
    input: type({ baseUrl: 'string', secret: secretString(), signUp: "'open' | 'closed'" }),
    expose: { api: authApiContract, session: authSessionContract, admin: authAdminContract },
    build: node({
      module: new URL('./auth-service.mjs', import.meta.url).href,
      entry: './auth-entrypoint.mjs',
    }),
  });
}

export default authService();
