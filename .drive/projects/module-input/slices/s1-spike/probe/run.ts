// Q2 and Q4: how Load records where each input field flows, and how the second pass substitutes it.
// Run: bun run.ts
import assert from 'node:assert/strict';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { type } from 'arktype';
import {
  isValue,
  Load,
  module,
  originOf,
  resolve,
  resolveValues,
  secretSource,
  secretString,
  service,
} from './core.ts';
import { inputValues } from './input-value.ts';
import { describeFlows, loadFirstPass, loadSecondPass, probeModule } from './probe-load.ts';

const section = (title: string) => console.log(`\n## ${title}\n`);
const show = (value: unknown) => console.log(JSON.stringify(value, null, 2));
const errorOf = (run: () => unknown): Error => {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected an error');
};

const build = {
  extension: '@prisma/composer/node',
  type: 'node',
  module: 'file:///probe.ts',
  entry: 'server.js',
};
const anySchema: StandardSchemaV1 = {
  '~standard': { version: 1, vendor: 'probe', validate: (value) => ({ value }) },
};
const shopFields = type({ host: 'string', from: 'string', smtp: { host: 'string' } });
const svc = (name: string) =>
  service({
    name,
    extension: 'probe/pack',
    type: 'probe/compute',
    inputs: {},
    params: {},
    input: anySchema,
    build,
  });

// ---------------------------------------------------------------------------
section('Q4. An input field is a core Value');
{
  const input = inputValues<typeof shopFields>('shop');
  const from = input.from;
  console.log('isValue(input.from):', isValue(from));
  console.log('isValue(input):', isValue(input));
  console.log('input.smtp.host === input.smtp.host:', input.smtp.host === input.smtp.host);
  console.log('originOf(input.smtp.host):', JSON.stringify(originOf(input.smtp.host)));
  const computed = resolve([from], ([f]) => f);
  console.log(
    "core resolve() accepts it as a dependency; the result's origin kind:",
    originOf(computed).kind,
  );
  assert.equal(isValue(from), true);
}

// ---------------------------------------------------------------------------
section('Q2. The example: root input, a child module, whole-input forwarding, resolve()');

const emailService = svc('emailService');
const webService = svc('web');

const email = probeModule(
  'email',
  { input: type({ from: 'string', deliveryCredential: secretString(), 'replyTo?': 'string' }) },
  ({ input, provision }) => {
    provision(emailService, {
      id: 'service',
      // Both casts are findings: InputBinding refuses Value<SecretString> and Value<string | undefined> today.
      input: {
        from: input.from,
        replyTo: input.replyTo as never,
        deliveryCredential: input.deliveryCredential as never,
      },
    });
  },
);
const relay = probeModule(
  'relay',
  { input: type({ from: 'string', deliveryCredential: secretString() }) },
  ({ input, provision }) => {
    provision(email, { input });
  },
);
const shop = probeModule(
  'shop',
  {
    input: type({
      EMAIL_FROM: 'string',
      'SITE_HOSTNAME?': 'string',
      WORKERS: 'string.integer.parse',
      credential: secretString(),
    }),
  },
  ({ input, environment, provision }) => {
    provision(email, { input: { from: input.EMAIL_FROM, deliveryCredential: input.credential } });
    provision(relay, { input: { from: input.EMAIL_FROM, deliveryCredential: input.credential } });
    const host = resolve(
      [input.SITE_HOSTNAME, environment.name],
      ([hostname, name]) => hostname ?? `${name}.shop.com`,
    );
    provision(webService, { input: { host, workers: input.WORKERS } });
  },
);

const credential = secretSource({ name: 'EMAIL_DELIVERY_CREDENTIAL' });
const graph = loadFirstPass(shop, { EMAIL_FROM: 'shop@example.com', WORKERS: '4', credential });
console.log('What the recorded bindings say flows where (first pass, nothing resolved yet):\n');
for (const line of describeFlows(graph)) console.log(`  ${line}`);

const staging = loadSecondPass(graph, { name: 'staging' });
console.log(
  '\nService bindings after the second pass, environment "staging", SITE_HOSTNAME not set:\n',
);
show(staging.serviceBindings);
const web = staging.serviceBindings.find((s) => s.address === 'shop.web');
assert.deepEqual(web?.binding, { host: 'staging.shop.com', workers: 4 });
const viaRelay = staging.serviceBindings.find((s) => s.address === 'shop.relay.email.service');
assert.equal((viaRelay?.binding as { deliveryCredential: unknown }).deliveryCredential, credential);
assert.equal('replyTo' in (viaRelay?.binding as object), false);

const withHost = loadSecondPass(
  loadFirstPass(shop, {
    EMAIL_FROM: 'shop@example.com',
    SITE_HOSTNAME: 'shop.com',
    WORKERS: '4',
    credential,
  }),
  { name: 'production' },
);
console.log(
  '\nshop.web after the second pass, environment "production", SITE_HOSTNAME=shop.com:\n',
);
show(withHost.serviceBindings.find((s) => s.address === 'shop.web'));

console.log(
  '\nThe secret source reaches shop.relay.email.service by identity, through two module validations:',
  (viaRelay?.binding as { deliveryCredential: unknown }).deliveryCredential === credential,
);

// ---------------------------------------------------------------------------
section("Q2. Validation of a module's binding names the module and field");
console.log(
  errorOf(() =>
    loadSecondPass(loadFirstPass(shop, { EMAIL_FROM: 'a@b.c', WORKERS: 'four', credential }), {
      name: 'x',
    }),
  ).message,
);
console.log(
  errorOf(() =>
    loadSecondPass(
      loadFirstPass(shop, { EMAIL_FROM: 'a@b.c', WORKERS: '4', credential: 'plain text' }),
      { name: 'x' },
    ),
  ).message,
);
const asyncSchema: StandardSchemaV1 = {
  '~standard': { version: 1, vendor: 'probe', validate: async (value) => ({ value }) },
};
console.log(
  errorOf(() =>
    loadSecondPass(
      loadFirstPass(
        probeModule('slow', { input: asyncSchema }, () => {}),
        {},
      ),
      { name: 'x' },
    ),
  ).message,
);

// ---------------------------------------------------------------------------
section("Q4. What today's core does with an input value");

console.log(
  "1. Core's resolveValues() collects it (isValue is true) but has no 'input' case, so it substitutes undefined:\n",
);
{
  const input = inputValues<typeof shopFields>('shop');
  const result = resolveValues({
    environment: { name: 'staging' },
    inputBindings: [{ serviceAddress: 'shop.web', binding: { host: input.host } }],
    params: [],
    resources: new Map(),
  });
  console.log('  resolved binding:', result.inputBindings[0]?.binding, '\n');
}

console.log(
  "2. Core's Load walks a service's input binding with deepValues() before the second pass. deepValues does not stop at a value, so it lists the value's keys:\n",
);
{
  const input = inputValues<typeof shopFields>('shop');
  const root = module('shop', ({ provision }) => {
    provision(svc('web'), { input: { host: input.host } });
  });
  console.log(`  ${errorOf(() => Load(root, { environment: { name: 'staging' } })).message}\n`);
  const control = module('shop', ({ environment, provision }) => {
    provision(svc('web'), { input: { host: environment.name } });
  });
  const graph = Load(control, { environment: { name: 'staging' } });
  console.log(
    '  Control: the same Load with environment.name in the binding passes (that value has no string keys). Resolved binding:',
    JSON.stringify(graph.inputBindings[0]?.binding),
    '\n',
  );
}

console.log(
  "3. checkResult() asks 'then' in result before isValue(result), so a resolve() function that returns an input value hits the in trap first:\n",
);
{
  const input = inputValues<typeof shopFields>('shop');
  const root = module('shop', ({ environment, provision }) => {
    // Typed as returning a string so it compiles; at runtime fn hands back the input value itself.
    provision(svc('web'), {
      input: { host: resolve([environment.name], (): string => input.host as never) },
    });
  });
  const error = errorOf(() => Load(root, { environment: { name: 'staging' } }));
  console.log(`  ${error.name}: ${error.message.split('. A module body')[0]}`);
}
