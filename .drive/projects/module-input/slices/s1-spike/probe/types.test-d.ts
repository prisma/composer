// Type tests. Run: tsc -p tsconfig.json. A passing compile is the evidence. Each line
// marked to expect an error fails the compile if that error goes away.
import { type } from 'arktype';
import { z } from 'zod';
import {
  environmentFacts as environment,
  type InputBinding,
  isSecretString,
  resolve,
  type SecretString,
  secretString,
  type Value,
} from './core.ts';
import type { InputValues } from './input-value.ts';
import { type Bindable, probeModule } from './probe-load.ts';

type Equal<A, B> =
  (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false;
function expectTrue<_ extends true>(): void {}
/** The real-value type a value stands for. */
type RealOf<V> = V extends Value<infer T> ? T : never;

// ---------- ArkType ----------
const arkShop = type({
  EMAIL_FROM: 'string',
  'SITE_HOSTNAME?': 'string',
  smtp: { host: 'string', port: 'number', 'tls?': { ca: 'string' } },
  tags: 'string[]',
  signingKey: secretString(),
  count: 'string.integer.parse',
});
declare const ark: InputValues<typeof arkShop>;

expectTrue<Equal<RealOf<typeof ark.EMAIL_FROM>, string>>();
expectTrue<Equal<RealOf<typeof ark.smtp>, { host: string; port: number; tls?: { ca: string } }>>();
expectTrue<Equal<RealOf<typeof ark.smtp.port>, number>>();
// An optional field is always present on `input`; its real value may be undefined.
expectTrue<Equal<RealOf<typeof ark.SITE_HOSTNAME>, string | undefined>>();
// Under an optional object, a nested field may be undefined too.
expectTrue<Equal<RealOf<typeof ark.smtp.tls>, { ca: string } | undefined>>();
expectTrue<Equal<RealOf<typeof ark.smtp.tls.ca>, string | undefined>>();
// An array field is one value; it has no element access.
expectTrue<Equal<RealOf<typeof ark.tags>, string[]>>();
// @ts-expect-error no element access on an array field
ark.tags[0];
// A secret field is typed from the output: SecretString. It exposes no members.
expectTrue<Equal<RealOf<typeof ark.signingKey>, SecretString>>();
// @ts-expect-error a secret field has no members; the body cannot call expose()
ark.signingKey.expose;
// A morph is typed from the schema's OUTPUT: 'string.integer.parse' takes a string and gives a number.
expectTrue<Equal<RealOf<typeof ark.count>, number>>();
// The whole input is a value too.
expectTrue<Equal<RealOf<typeof ark>, typeof arkShop.infer>>();
// @ts-expect-error a key the schema does not declare
ark.nope;
// @ts-expect-error fields are read-only
ark.EMAIL_FROM = ark.EMAIL_FROM;

// Every field is a core Value, so it is accepted where a Value is.
const asValue: Value<string> = ark.EMAIL_FROM;
void asValue;
const servicePlain: InputBinding = {
  from: ark.EMAIL_FROM,
  port: ark.smtp.port,
  tags: ark.tags,
  smtp: ark.smtp,
};
void servicePlain;

// resolve() over input fields: fn receives the real values, typed.
resolve([ark.SITE_HOSTNAME, environment.name], (values) => {
  expectTrue<Equal<typeof values, readonly [string | undefined, string]>>();
  const [hostname, name] = values;
  return hostname ?? `${name}.shop.com`;
});
resolve([ark.smtp], ([smtp]) => `${smtp.host}:${smtp.port}`);

// ---------- Zod ----------
const zodShop = z.object({
  EMAIL_FROM: z.string(),
  SITE_HOSTNAME: z.string().optional(),
  smtp: z.object({
    host: z.string(),
    port: z.number(),
    tls: z.object({ ca: z.string() }).optional(),
  }),
  tags: z.array(z.string()),
  signingKey: z.custom<SecretString>(isSecretString),
  count: z.string().transform((s) => Number.parseInt(s, 10)),
});
declare const zod: InputValues<typeof zodShop>;

expectTrue<Equal<RealOf<typeof zod.EMAIL_FROM>, string>>();
expectTrue<Equal<RealOf<typeof zod.smtp.port>, number>>();
expectTrue<Equal<RealOf<typeof zod.SITE_HOSTNAME>, string | undefined>>();
expectTrue<Equal<RealOf<typeof zod.smtp.tls.ca>, string | undefined>>();
expectTrue<Equal<RealOf<typeof zod.tags>, string[]>>();
expectTrue<Equal<RealOf<typeof zod.signingKey>, SecretString>>();
expectTrue<Equal<RealOf<typeof zod.count>, number>>();

// ---------- A discriminated union (the stripe example of the service-input decision) ----------
const zodChat = z.discriminatedUnion('stripeEnabled', [
  z.object({ stripeEnabled: z.literal(false) }),
  z.object({
    stripeEnabled: z.literal(true),
    stripeSecretKey: z.custom<SecretString>(isSecretString),
    stripeWebhookSecret: z.custom<SecretString>(isSecretString),
  }),
]);
declare const chat: InputValues<typeof zodChat>;
// Only the keys every member shares are fields. The discriminant is one value over both literals.
expectTrue<Equal<RealOf<typeof chat.stripeEnabled>, boolean>>();
// @ts-expect-error a key only one member has is not a field: the body cannot narrow, so it cannot reach it
chat.stripeSecretKey;
// The whole input carries the union; forward it, or narrow inside resolve().
expectTrue<Equal<RealOf<typeof chat>, z.output<typeof zodChat>>>();
resolve([chat], ([real]) => (real.stripeEnabled ? 'stripe on' : 'stripe off'));

const arkChat = type({ stripeEnabled: 'false' }).or({
  stripeEnabled: 'true',
  stripeSecretKey: secretString(),
  stripeWebhookSecret: secretString(),
});
declare const arkUnion: InputValues<typeof arkChat>;
expectTrue<Equal<RealOf<typeof arkUnion.stripeEnabled>, boolean>>();
// @ts-expect-error same with ArkType
arkUnion.stripeSecretKey;

// ---------- provision(child, { input }) ----------
const emailInput = type({
  from: 'string',
  deliveryCredential: secretString(),
  'replyTo?': 'string',
});
const email = probeModule('email', { input: emailInput }, () => {});

probeModule('shop', { input: arkShop }, ({ input, provision }) => {
  provision(email, { input: { from: input.EMAIL_FROM, deliveryCredential: input.signingKey } });
  // An optional value into an optional field is fine.
  provision(email, {
    input: {
      from: input.EMAIL_FROM,
      deliveryCredential: input.signingKey,
      replyTo: input.SITE_HOSTNAME,
    },
  });
  // @ts-expect-error an optional value cannot fill a required field
  provision(email, { input: { from: input.SITE_HOSTNAME, deliveryCredential: input.signingKey } });
  // @ts-expect-error a number value cannot fill a string field
  provision(email, { input: { from: input.smtp.port, deliveryCredential: input.signingKey } });
});

// Forwarding the whole input: the parent's output must be assignable to the child's input.
const relay = probeModule('relay', { input: emailInput }, ({ input, provision }) => {
  provision(email, { input });
});
void relay;
probeModule('wrong', { input: type({ from: 'number' }) }, ({ input, provision }) => {
  // @ts-expect-error the whole input does not fit the child's schema
  provision(email, { input });
});

// A binding can also be checked directly.
const okBinding: Bindable<typeof emailInput.inferIn> = {
  from: 'a@b.c',
  deliveryCredential: ark.signingKey,
};
void okBinding;

// ---------- A record field ----------
const withLabels = type({ labels: 'Record<string, string>' });
declare const labelled: InputValues<typeof withLabels>;
// Any key reads, as bracket access (noPropertyAccessFromIndexSignature), and may be absent.
expectTrue<Equal<RealOf<(typeof labelled.labels)['team']>, string | undefined>>();
expectTrue<Equal<RealOf<typeof labelled.labels>, Record<string, string>>>();
