# S9 manual QA

Run 2026-11-02 in the `claude/module-input-s9` worktree, after `pnpm build`. No Prisma Cloud deploy: deploy output does not change.

## 1. The compile error an author sees, and the Load error behind a missing type check

`examples/email/src/s9-qa.ts`, written as the spec gives it, passes the relay module's whole `input` to `email()`. `pnpm --filter @prisma/example-email typecheck` exited 2:

```text
src/s9-qa.ts(17,26): error TS2769: No overload matches this call.
  The last overload gave the following error.
    Type 'ModuleInput<Type<{ deliveryMode: string | Pointer<string>; from: string | Pointer<string>; deliveryCredential: SecretString | Pointer<SecretString>; }, {}>>' is not assignable to type 'ModuleInputBinding<{ deliveryMode: string | Pointer<string>; from: string | Pointer<string>; deliveryCredential: SecretString | Pointer<SecretString>; }>'.
      Type 'ModuleInput<Type<{ deliveryMode: string | Pointer<string>; from: string | Pointer<string>; deliveryCredential: SecretString | Pointer<SecretString>; }, {}>>' is not assignable to type '{ readonly deliveryMode: ModuleInputBinding<string | Pointer<string>>; readonly from: ModuleInputBinding<string | Pointer<string>>; readonly deliveryCredential: ModuleInputBinding<...>; } & NotModuleInput'.
        Type 'ModuleInput<Type<{ deliveryMode: string | Pointer<string>; from: string | Pointer<string>; deliveryCredential: SecretString | Pointer<SecretString>; }, {}>>' is not assignable to type 'NotModuleInput'.
          Types of property '[MODULE_INPUT]' are incompatible.
            Type 'true' is not assignable to type '"the whole input of a module is not a value; pass its fields on by name"'.
```

The error ends with the message. `bun src/s9-qa.ts` in `examples/email`, which does not check types, printed:

```text
the input binding of module "shop.relay.email" depends on the whole input of module "shop.relay". A module body's input is a dictionary of values, not a value, so it cannot be passed on whole. Pass its fields on by name, such as input.from.
```

Then `src/s9-qa.ts` was deleted.

## 2. The root's Load error

`examples/email/src/s9-qa-root.ts`, written as the spec gives it, passes the root's whole `input` to `email()` through `as never`. `bun src/s9-qa-root.ts` in `examples/email` printed:

```text
the input binding of module "shop.email" depends on the whole input of module "shop". A module body's input is a dictionary of values, not a value, so it cannot be passed on whole. The root's input is every value the `config` adapters return, which by default is every variable of the process environment, secrets included. Pass its fields on by name, such as input.from.
```

Then `src/s9-qa-root.ts` was deleted.

## 3. The examples still type-check

`pnpm --filter @prisma/example-email typecheck` and `pnpm --filter @prisma/example-storefront-auth typecheck` each exited 0. `git status` showed only this slice's changes.
