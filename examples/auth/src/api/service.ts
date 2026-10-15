/**
 * The api service: the app origin. Wires the auth module's public port
 * twice — `rawHttp()` (the proxy's upstream) and `jwtVerifier()` (stateless
 * verification over the same instance's JWKS) — plus the `session` rpc port
 * for the explicit instant-logout lookup.
 */
import { rawHttp } from '@prisma/composer/http';
import node from '@prisma/composer/node';
import { rpc } from '@prisma/composer/service-rpc';
import { compute } from '@prisma/composer-prisma-cloud';
import { authSessionContract, jwtVerifier } from '@prisma/composer-prisma-cloud/auth';

export default compute({
  name: 'api',
  deps: { authApi: rawHttp(), verifier: jwtVerifier(), session: rpc(authSessionContract) },
  build: node({ module: import.meta.url, entry: '../../dist/api/server.mjs' }),
});
