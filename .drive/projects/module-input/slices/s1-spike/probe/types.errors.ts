// Compiled on its own (tsc -p tsconfig.errors.json) so the report can show the compiler's own messages.
// Every line below is meant to fail.
import { type } from 'arktype';
import { type InputBinding, secretString, type Value } from './core.ts';
import type { InputValues } from './input-value.ts';
import { probeModule } from './probe-load.ts';

type Equal<A, B> =
  (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false;
function expectTrue<_ extends true>(): void {}
type RealOf<V> = V extends Value<infer T> ? T : never;

const shop = type({
  EMAIL_FROM: 'string',
  'SITE_HOSTNAME?': 'string',
  tags: 'string[]',
  signingKey: secretString(),
});
declare const input: InputValues<typeof shop>;

// 1. The Equal helper is not vacuous: a wrong expectation fails.
expectTrue<Equal<RealOf<typeof input.SITE_HOSTNAME>, string>>();

// 2. Element access on an array field.
input.tags[0];

// 3. A secret field has no members.
input.signingKey.expose();

// 4. A key the schema does not declare.
input.nope;

// 5. FINDING: a secret field cannot be bound into a service's input today, because
//    InputBinding accepts only Value<PlainData> and SecretString is a class instance.
const serviceBinding: InputBinding = { signingKey: input.signingKey };
void serviceBinding;

// 6. An optional value into a required field of a child module.
const email = probeModule('email', { input: type({ from: 'string' }) }, () => {});
probeModule('shop', { input: shop }, ({ input: own, provision }) => {
  provision(email, { input: { from: own.SITE_HOSTNAME } });
});

// 7. Comparing and branching. The runtime cannot catch these; this shows which the compiler catches.
const flagSchema = type({ flag: 'boolean', kind: "'a' | 'b'", 'hostname?': 'string' });
declare const flags: InputValues<typeof flagSchema>;
if (flags.flag === true) {
}
switch (flags.kind) {
  case 'a':
    break;
}
const fallback = flags.hostname ?? 'fallback';
void fallback;
if (flags.flag) {
}
const negated = !flags.flag;
void negated;
const kindIsText = typeof flags.kind === 'string';
void kindIsText;

// 8. FINDING: an optional field cannot be bound into a service's input today either:
//    InputBinding accepts Value<PlainData>, and undefined is not PlainData.
const optionalIntoService: InputBinding = { hostname: input.SITE_HOSTNAME };
void optionalIntoService;
