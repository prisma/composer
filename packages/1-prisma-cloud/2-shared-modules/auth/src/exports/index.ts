/**
 * `@internal/auth`'s authoring barrel: the rpc port contracts, the wire
 * record schemas, the `jwtVerifier()` dependency, the email templates, and
 * the `auth()` module. The `api` port is a raw HTTP port: a consumer wires it
 * with `rawHttp()` from `@internal/http`. The
 * runtime engine (store, handlers, entrypoint) stays OUT of this barrel, so
 * a consumer graph that imports this module never bundles a `node:`/`bun`
 * token. The pack has its own subpath (`./pack`).
 */
export type { AuthModuleOptions } from '../auth-module.ts';
export { auth } from '../auth-module.ts';
export type {
  JwtVerifier,
  SessionRecord,
  SignUpMode,
  UserRecord,
  VerifiedSession,
} from '../contract.ts';
export {
  authAdminContract,
  authDb,
  authSessionContract,
  jwtVerifier,
  sessionRecord,
  userRecord,
} from '../contract.ts';
export type { AuthProxyTarget } from '../proxy.ts';
export { authProxy } from '../proxy.ts';
export type { AuthTemplates } from '../templates.ts';
export { authTemplates } from '../templates.ts';
export { authService } from './auth-service.ts';
