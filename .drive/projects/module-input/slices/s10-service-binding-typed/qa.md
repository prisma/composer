# S10 manual QA

Run 2026-11-02 in the `claude/module-input-s9` worktree, after `pnpm build`. No Prisma Cloud deploy: no input document, stack file or deploy report changes.

## 1. The compile errors an author sees

`examples/email/src/s10-qa.ts`, written as the spec gives it, passes the relay module's whole `input` to the relay service, and binds `envSecret()` to a wrapped text field and `serviceOrigin()` to a plain field. `pnpm --filter @prisma/example-email typecheck` exited 2 with three `TS2769` errors, at `(21,29)`, `(35,7)` and `(36,7)`, as the spec's § 8 quotes. TypeScript joins the chains of the errors on lines 35 and 36:

```text
src/s10-qa.ts(21,29): error TS2769: No overload matches this call.
  The last overload gave the following error.
    Type 'ModuleInput<Type<{ from: string | Pointer<string>; host: string; deliveryCredential: SecretString | Pointer<SecretString>; }, {}>>' is not assignable to type 'InputBindingOf<Type<{ from: string | Pointer<string>; host: string; deliveryCredential: SecretString | Pointer<SecretString>; }, {}>>'.
      Type 'ModuleInput<Type<{ from: string | Pointer<string>; host: string; deliveryCredential: SecretString | Pointer<SecretString>; }, {}>>' is not assignable to type '{ readonly from: InputBinding<string | Pointer<string>>; readonly host: InputBinding<string>; readonly deliveryCredential: InputBinding<SecretString | Pointer<...>>; } & NotModuleInput'.
        Type 'ModuleInput<Type<{ from: string | Pointer<string>; host: string; deliveryCredential: SecretString | Pointer<SecretString>; }, {}>>' is not assignable to type 'NotModuleInput'.
          Types of property '[MODULE_INPUT]' are incompatible.
            Type 'true' is not assignable to type '"the whole input of a module is not a value; pass its fields on by name"'.
src/s10-qa.ts(35,7): error TS2769: No overload matches this call.
  The last overload gave the following error.
    Type 'SecretSource<EnvSecretPayload> & RuntimeValue<SecretString>' is not assignable to type 'InputBinding<string | Pointer<string>>'.
      Type 'SecretSource<EnvSecretPayload> & RuntimeValue<SecretString>' is not assignable to type 'Value<string | Pointer<string>>' with 'exactOptionalPropertyTypes: true'. Consider adding 'undefined' to the types of the target's properties.
        Types of property '[VALUE_TYPE]' are incompatible.
          Type 'Pointer<SecretString>' is not assignable to type 'string | Pointer<string>'.
            Type 'PointerWithKind<SecretString, "plain">' is not assignable to type 'Pointer<string>' with 'exactOptionalPropertyTypes: true'. Consider adding 'undefined' to the types of the target's properties.
              Type 'SecretString' is not assignable to type 'string'.
                Type 'ParamSource<OriginParamPayload> & RuntimeValue<string>' is not assignable to type 'InputBinding<string>'.
                  Type 'ParamSource<OriginParamPayload> & RuntimeValue<string>' is not assignable to type 'Value<string>' with 'exactOptionalPropertyTypes: true'. Consider adding 'undefined' to the types of the target's properties.
                    Types of property '[VALUE_TYPE]' are incompatible.
                      Type 'Pointer<string>' is not assignable to type 'string'.
src/s10-qa.ts(36,7): error TS2769: No overload matches this call.
  The last overload gave the following error.
    Type 'SecretSource<EnvSecretPayload> & RuntimeValue<SecretString>' is not assignable to type 'InputBinding<string | Pointer<string>>'.
      Type 'SecretSource<EnvSecretPayload> & RuntimeValue<SecretString>' is not assignable to type 'Value<string | Pointer<string>>' with 'exactOptionalPropertyTypes: true'. Consider adding 'undefined' to the types of the target's properties.
        Types of property '[VALUE_TYPE]' are incompatible.
          Type 'Pointer<SecretString>' is not assignable to type 'string | Pointer<string>'.
            Type 'PointerWithKind<SecretString, "plain">' is not assignable to type 'Pointer<string>' with 'exactOptionalPropertyTypes: true'. Consider adding 'undefined' to the types of the target's properties.
              Type 'SecretString' is not assignable to type 'string'.
                Type 'ParamSource<OriginParamPayload> & RuntimeValue<string>' is not assignable to type 'InputBinding<string>'.
                  Type 'ParamSource<OriginParamPayload> & RuntimeValue<string>' is not assignable to type 'Value<string>' with 'exactOptionalPropertyTypes: true'. Consider adding 'undefined' to the types of the target's properties.
                    Types of property '[VALUE_TYPE]' are incompatible.
                      Type 'Pointer<string>' is not assignable to type 'string'.
```

The first error ends with the message. `bun src/s10-qa.ts` in `examples/email`, which does not check types, printed:

```text
the input binding of service "shop.relay.relay" depends on the whole input of module "shop.relay". A module body's input is a dictionary of values, not a value, so it cannot be passed on whole. Pass its fields on by name, such as input.from.
```

Then `src/s10-qa.ts` was deleted.

## 2. The examples still type-check, and the auth example loads

`pnpm --filter @prisma/example-email typecheck`, `pnpm --filter @prisma/example-auth typecheck`, `pnpm --filter @prisma/example-storefront-auth typecheck` and `pnpm --filter @prisma/example-cron typecheck` each exited 0. `bun test tests/module.test.ts` in `examples/auth` passed, 1 test. `git status` showed only this slice's changes, beside another session's untracked S11 to S13 spec folder.
