/**
 * `@internal/auth`'s authoring barrel: the three port contracts, the wire
 * record schemas, the consumer dependency factories (`authApi()`,
 * `jwtVerifier()`), the email templates, and the `auth()` module. The
 * runtime engine (store, handlers, entrypoint) stays OUT of this barrel, so
 * a consumer graph that imports this module never bundles a `node:`/`bun`
 * token. The pack has its own subpath (`./pack`).
 */
export type { AuthModuleOptions } from '../auth-module.ts';
export { auth } from '../auth-module.ts';
export type {
  AuthApiClient,
  AuthApiConfig,
  JwtVerifier,
  SessionRecord,
  SignUpMode,
  UserRecord,
  VerifiedSession,
} from '../contract.ts';
export {
  authAdminContract,
  authApi,
  authApiContract,
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
