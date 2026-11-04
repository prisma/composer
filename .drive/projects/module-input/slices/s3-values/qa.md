# S3 manual QA

Run on 2026-10-29 after `pnpm build`, against Prisma Cloud in `us-east-1` with the QA workspace credentials. Every deploy below was torn down afterwards with the example's `destroy` script.

## 1. Unchanged, deployed

`examples/env-param`, under the stack name `s3qa-env-param` so it does not touch the workspace's existing `env-param-example` project:

```sh
ENV_PARAM_GREETING=hi ENV_PARAM_STACK_NAME=s3qa-env-param pnpm run deploy
EXPECTED_GREETING=hi ENV_PARAM_STACK_NAME=s3qa-env-param pnpm run smoke:deployed
```

```
✔ Deployed s3qa-env-param to production in 29.8s.
ok - s3qa-env-param.site is a public-url entity at echo's URL https://pxd4ooo4ttcbplg6j3b3u8d7.ewr.prisma.build
ok - production serves greeting "hi"
ok - production serves environment "deployed to production"
ok - https://pxd4ooo4ttcbplg6j3b3u8d7.ewr.prisma.build/logo.svg serves the entry's sibling asset — the whole tree arrived
```

`examples/auth`, with its `.env.example` copied to `.env` (delivery mode `none`):

```sh
pnpm run deploy
pnpm run smoke:deployed
```

The deploy succeeded. The smoke script as committed fails before it tests anything: it looks up the platform apps named `api` and `ops`, but the apps are named by full address (`auth-example.api`, `auth-example.ops`). This is not caused by this slice. With a working-tree edit of `scripts/smoke.ts` that looks up `${stack}.api` and `${stack}.ops`, reverted afterwards:

```
ok   - health: api and ops answer
ok   - signup through the proxied /api/auth/sign-up/email
…
ok   - removeUser through the ops service is idempotent on a deleted account

15 passed, 0 failed
```

## 2. Unchanged, local

```sh
ENV_PARAM_GREETING=hi prisma dev --detach
curl "$(prisma dev url env-param-example.echo)"
prisma dev stop
```

```
{"greeting":"hi","environment":"deployed to dev"}
```

## 3. A source in a module's input

A working-tree edit of `examples/env-param/module.ts`:

```ts
const greeter = module(
  'greeter',
  { input: type({ greeting: 'string', environment: 'string' }) },
  ({ input, provision }) => {
    provision(echoService, {
      input: { greeting: input.greeting, environment: input.environment },
    });
  },
);

export default module('env-param-example', ({ environment, provision }) => {
  provision(greeter, {
    input: {
      greeting: envParam('ENV_PARAM_GREETING'),
      environment: resolve(
        [envParam('ENV_PARAM_GREETING'), environment.name],
        ([g, name]) => `${g} from ${name}`,
      ),
    },
  });
});
```

```sh
ENV_PARAM_GREETING=hi prisma dev --detach
curl "$(prisma dev url env-param-example.greeter.echo)"
prisma dev stop
```

```
{"greeting":"hi","environment":"hi from dev"}
```

## 4. A source cannot be read

The same edit with `` greeting: `${envParam('ENV_PARAM_GREETING')}` ``:

```sh
ENV_PARAM_GREETING=hi prisma dev
```

```
✘ [COMPOSE.GRAPH_INVALID] envParam('ENV_PARAM_GREETING') is a value, not its real value, and it was turned into text (a template literal or String()). A module body can only pass it on: into a provision() binding or as a resolve() dependency. To compute with it, list it: resolve([envParam('ENV_PARAM_GREETING')], ([v]) => …).
```

Exit code 2; nothing started.

## 5. Preflight checks a secret no service receives

The edit's `greeter` schema gains `'key?': secretString()`, its body does not forward it, and the root binds `key: envSecret('S3_QA_UNSET_SECRET')`. With that variable set nowhere:

```sh
ENV_PARAM_GREETING=hi ENV_PARAM_STACK_NAME=s3qa-env-param pnpm run deploy
```

```
▸ check environment variables
✘ check environment variables (333ms)
✘ [DEPLOY.PREFLIGHT_FAILED] Deploy failed. 1 required setting has no value:
  - S3_QA_UNSET_SECRET  (used by module "s3qa-env-param.greeter")
```

The deploy engine did not run. The module's address starts with `s3qa-env-param` because of the stack name override.

## 6. Clean-up

`git checkout examples/env-param/module.ts`. Both deploys were destroyed (`Removed the Project … Destroyed.`); `destroy` for env-param needs `ENV_PARAM_GREETING` set, because it evaluates the stack.
