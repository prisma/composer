# S6 manual QA

Run 2026-10-30 on a local machine, after `pnpm build`. Nothing was deployed.

## 1. The published package, outside the workspace

`pnpm pack` of `packages/9-public/composer` into a fresh directory gave `prisma-composer-0.36.0.tgz`. In that directory, after `npm init -y` and `npm install ./prisma-composer-*.tgz arktype@2.2.7 zod@4.4.3`, `npm ls zod` printed:

```text
+-- @prisma/composer@0.36.0
| `-- zod@4.4.3 deduped
`-- zod@4.4.3
```

`node check.mjs`, with the file the spec gives, printed exactly the four expected lines:

```text
from must be a string (was a number)
Invalid input: expected string, received undefined
must be a SecretString box — bind this field to a secret (was a string)
false false
```

## 2. Sources still reach a running service

In `examples/email`, with `EMAIL_DELIVERY_MODE`, `EMAIL_FROM` and `EMAIL_DELIVERY_CREDENTIAL` unset in the shell, `.env.dev` held `EMAIL_DELIVERY_MODE=none`, `EMAIL_FROM=s6-qa-dev@example.com` and `EMAIL_DELIVERY_CREDENTIAL=local-dev-unused`.

`prisma dev --detach` ended with `Done: 20 succeeded` and `dev: ready`. `prisma dev url email-example.mailer` gave `http://localhost:3204`. The signup returned an id, and reading the email back showed the configured sender:

```text
{"id":"06e1e6e6-438b-4763-91b0-9197b019b150"}
"from":"s6-qa-dev@example.com"
```

`prisma dev stop` stopped the app, `.env.dev` was removed, and `git status` showed no change outside this slice's commits.

## 3. Other Zod and ArkType versions than the repo's, after the review fixes

Run 2026-10-30, after `pnpm build`. The repo uses `zod@4.4.3` and `arktype@2.2.7`; this probe installs `zod@4.6.7` and `arktype@2.2.9`, the latest published 4.x and 2.x. `zod` and `arktype` are now optional peer dependencies of `@prisma/composer`, so the app's copy is the only one.

`pnpm pack` of `packages/9-public/composer` into a fresh directory gave `prisma-composer-0.36.0.tgz`, which bundles the internal packages. In that directory, after `npm init -y` and `npm install ./prisma-composer-0.36.0.tgz zod@4.6.7 arktype@2.2.9`, `npm ls zod arktype` printed:

```text
+-- @prisma/composer@0.36.0
| +-- arktype@2.2.9 deduped
| `-- zod@4.6.7 deduped
+-- arktype@2.2.9
`-- zod@4.6.7
```

`probe.mjs` builds a secret pointer with `secretSource()` and a plain pointer with `paramSource(…, { sentinel })`, both from `@prisma/composer`, and checks `field()` and `secretString()` from each entry point under the key `u`:

```js
import { isPlainPointer, isSecretPointer, paramSource, SecretBox, secretSource } from '@prisma/composer';
import * as ark from '@prisma/composer/arktype';
import * as zod from '@prisma/composer/zod';
import { type } from 'arktype';
import { z } from 'zod';

const secret = secretSource({ name: 'K' });
const plain = paramSource({ name: 'P' }, { sentinel: 'x' });
console.log('kinds:', isSecretPointer(secret), isPlainPointer(plain));

const arkCheck = (schema, value) => {
  const out = type({ u: schema })({ u: value });
  return out instanceof type.errors ? `refused: ${out.summary}` : 'accepted';
};
const zodCheck = (schema, value) => {
  const out = z.object({ u: schema }).safeParse({ u: value });
  return out.success ? 'accepted' : `refused: ${out.error.issues[0].message}`;
};

for (const [name, check, lib] of [
  ['arktype', arkCheck, { field: ark.field(type('string')), secretString: ark.secretString(), plainMessage: type({ u: 'string' })({ u: 3 }).summary }],
  ['zod', zodCheck, { field: zod.field(z.string()), secretString: zod.secretString(), plainMessage: z.object({ u: z.string() }).safeParse({ u: 3 }).error.issues[0].message }],
]) {
  console.log(`--- ${name}`);
  console.log('field, value "a":', check(lib.field, 'a'));
  console.log('field, plain pointer:', check(lib.field, plain));
  console.log('field, secret pointer:', check(lib.field, secret));
  console.log('field, number 3:', check(lib.field, 3));
  console.log('plain field, number 3: refused:', lib.plainMessage);
  console.log('secretString, SecretBox:', check(lib.secretString, new SecretBox('s')));
  console.log('secretString, secret pointer:', check(lib.secretString, secret));
  console.log('secretString, plain pointer:', check(lib.secretString, plain));
}
```

`node probe.mjs` printed:

```text
kinds: true true
--- arktype
field, value "a": accepted
field, plain pointer: accepted
field, secret pointer: refused: u must be a string (was an object)
field, number 3: refused: u must be a string (was a number)
plain field, number 3: refused: u must be a string (was a number)
secretString, SecretBox: accepted
secretString, secret pointer: accepted
secretString, plain pointer: refused: u must be a SecretString box — bind this field to a secret (was a value known only at boot that is not a secret)
--- zod
field, value "a": accepted
field, plain pointer: accepted
field, secret pointer: refused: Invalid input: expected string, received object
field, number 3: refused: Invalid input: expected string, received number
plain field, number 3: refused: Invalid input: expected string, received number
secretString, SecretBox: accepted
secretString, secret pointer: accepted
secretString, plain pointer: refused: must be a SecretString box — bind this field to a secret (was a value known only at boot that is not a secret)
```

Both entry points accept a value and the right pointer kind, refuse the wrong kind, and a wrapped field refusing a number gives the plain field's message.
