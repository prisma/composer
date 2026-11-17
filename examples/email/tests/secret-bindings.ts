// Compiled by the typecheck, never run: a platform secret fits `secretString()` only while the
// cloud package's declarations import `SecretBox` from `@prisma/composer` rather than copy it.
import { appRoot } from '@prisma/composer';
import { secretString } from '@prisma/composer/arktype';
import node from '@prisma/composer/node';
import { compute, generatedParam, serviceOrigin, variable } from '@prisma/composer-prisma-cloud';
import { type } from 'arktype';

const relay = compute({
  name: 'relay',
  deps: {},
  build: node({ module: import.meta.url, entry: 'relay.mjs' }),
  input: type({ apiKey: secretString() }),
});

export default appRoot('secret-bindings', ({ provision }) => {
  provision(relay, { id: 'generated', deps: {}, input: { apiKey: generatedParam() } });
  const apiKey = provision(variable.secret({ name: 'RELAY_API_KEY' }));
  provision(relay, { id: 'platform', deps: {}, input: { apiKey } });
  // @ts-expect-error a plain runtime value does not fit a secret field
  provision(relay, { id: 'origin', deps: {}, input: { apiKey: serviceOrigin('relay') } });
});
