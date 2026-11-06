/**
 * Compiled by this example's typecheck against the built public packages, never
 * run. A secret source from `@prisma/composer-prisma-cloud` must fit a service's
 * `secretString()` field from `@prisma/composer/arktype`, which holds only while
 * the cloud package's declarations import `SecretBox` from `@prisma/composer`
 * instead of carrying their own copy.
 */
import { module } from '@prisma/composer';
import { secretString } from '@prisma/composer/arktype';
import node from '@prisma/composer/node';
import { compute, envSecret, generatedParam, serviceOrigin } from '@prisma/composer-prisma-cloud';
import { type } from 'arktype';

const relay = compute({
  name: 'relay',
  deps: {},
  build: node({ module: import.meta.url, entry: 'relay.mjs' }),
  input: type({ apiKey: secretString() }),
});

export default module('secret-bindings', ({ provision }) => {
  provision(relay, { id: 'generated', deps: {}, input: { apiKey: generatedParam() } });
  provision(relay, { id: 'env', deps: {}, input: { apiKey: envSecret('RELAY_API_KEY') } });
  // @ts-expect-error a plain runtime value does not fit a secret field
  provision(relay, { id: 'origin', deps: {}, input: { apiKey: serviceOrigin('relay') } });
});
