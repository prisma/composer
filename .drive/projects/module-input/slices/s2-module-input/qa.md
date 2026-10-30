# S2 manual QA

Run on 2026-10-29 in `examples/env-param`, after `pnpm build`, with a working-tree edit of `module.ts` that moves `echoService` into a module `greeter`:

```ts
const greeter = module(
  'greeter',
  { input: type({ environment: 'string' }) },
  ({ input, provision }) => {
    provision(echoService, {
      input: { greeting: envParam('ENV_PARAM_GREETING'), environment: input.environment },
    });
  },
);

export default module('env-param-example', ({ environment, provision }) => {
  const label = resolve([environment.name], ([name]) => `deployed to ${name}`);
  provision(greeter, { input: { environment: label } });
});
```

## The field reaches the service

```sh
ENV_PARAM_GREETING=hi prisma dev --detach
curl "$(prisma dev url env-param-example.greeter.echo)"
```

```
dev: ready
env-param-example.greeter.echo: http://localhost:3144
{"greeting":"hi","environment":"deployed to dev"}
```

## Reading the field in the body fails before anything starts

The same edit with `` environment: `${input.environment}` `` in `greeter`'s body:

```sh
ENV_PARAM_GREETING=hi prisma dev
```

```
✘ [COMPOSE.GRAPH_INVALID] input.environment of module "env-param-example.greeter" is a value, not its real value, and it was turned into text (a template literal or String()). A module body can only pass an input field on: into a provision() binding or as a resolve() dependency. To compute with it, list it: resolve([input.environment], ([v]) => …).
```

Exit code 2. Then `git checkout examples/env-param/module.ts` and `prisma dev stop`.
