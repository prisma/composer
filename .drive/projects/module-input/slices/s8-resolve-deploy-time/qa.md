# S8 manual QA

Run 2026-10-30 in the `claude/module-input-s8` worktree, after `pnpm build`. No Prisma Cloud deploy: deploy output does not change, and nothing in this slice reaches the platform.

## 1. The compile error an author sees

In `examples/env-param/module.ts`, the import became `import { envParam, envSecret, publicUrl } from '@prisma/composer-prisma-cloud';` and the `resolve` line became ``const label = resolve([environment.name, envSecret('GREETING_KEY')], ([name]) => `deployed to ${name}`);``. `pnpm --filter @prisma/example-env-param typecheck` exited 2:

```text
module.ts(17,44): error TS2322: Type 'SecretSource<EnvSecretPayload> & RuntimeValue<SecretString>' is not assignable to type '"a resolve() dependency must be a deploy-time value, never a value known only at boot or a field wrapped with field(); to compute with an input field, declare it plain"'.
module.ts(18,26): error TS2769: No overload matches this call.
  The last overload gave the following error.
    Argument of type 'ComputeService<{}, Type<{ greeting: string; environment: string; }, {}>, { http: Contract<"http", { readonly url: string; }>; }>' is not assignable to parameter of type 'ModuleNode<Deps, Readonly<Record<string, AnyContract>>, StandardSchemaV1<unknown, unknown> | undefined>'.
      Type 'ComputeService<{}, Type<{ greeting: string; environment: string; }, {}>, { http: Contract<"http", { readonly url: string; }>; }>' is missing the following properties from type 'ModuleNode<Deps, Readonly<Record<string, AnyContract>>, StandardSchemaV1<unknown, unknown> | undefined>': deps, body
module.ts(21,82): error TS2339: Property 'http' does not exist on type '{ readonly id: string; } & (Record<never, never> | RefPort<AnyContract>)'.
  Property 'http' does not exist on type '{ readonly id: string; } & Record<never, never>'.
```

The first error is the message, at the dependency. The other two follow because the failed call's result is typed `Value<unknown>`. Then `git checkout -- examples/env-param/module.ts`.

## 2. The Load error an author sees

`examples/env-param/s8-qa.ts`, written as the spec gives it, lists `envSecret('GREETING_KEY') as Value<unknown>`. `bun s8-qa.ts` printed:

```text
The resolve() function for input key "environment" of service "env-param-example.echo" lists envSecret('GREETING_KEY'), which is known only at boot. A resolve() dependency must be a deploy-time value. Bind envSecret('GREETING_KEY') directly into the input of the service that reads it.
```

Then `s8-qa.ts` was deleted.

## 3. The example still type-checks and loads

`pnpm --filter @prisma/example-env-param typecheck` exited 0, and `git status` was clean.
