# Purpose

Let a module take its input the way a service does: one Standard Schema, `input`, bound by whoever provisions it. Let the root module declare `input` too, filled from config adapters named in `prisma.config.ts`. Before this project a module declared per-key `params` and `secrets` slots that accepted only a source, never a literal, and the root had no input at all.

The design is [design.md](design.md), which is authoritative. The slices are in [plan.md](plan.md).

# At a glance

```ts
// a reusable module declares what it needs, as a service does
import { field, secretString } from '@prisma/composer/arktype';

export default module('email',
  { input: type({ from: field(type('string')), deliveryCredential: secretString() }), expose: { send: emailSendContract } },
  ({ input, provision }) => {
    const service = provision(emailService(), {
      id: 'service',
      input: { from: input.from, deliveryCredential: input.deliveryCredential },
    });
    return { send: service.send };
  });

// the root declares its own input; the deploy fills it from the config adapters
export default module('shop',
  { input: type({ EMAIL_FROM: 'string', 'SITE_HOSTNAME?': 'string' }) },
  ({ input, environment, provision }) => {
    provision(email(), {
      input: { from: input.EMAIL_FROM, deliveryCredential: envSecret('EMAIL_DELIVERY_CREDENTIAL') },
    });
    const host = resolve([input.SITE_HOSTNAME, environment.name], ([hostname, name]) =>
      hostname ?? `${name}.shop.com`);
    // …
  });
```

```ts
// prisma.config.ts
composer({ extensions: [prismaCloud(), nodeBuild()], state: prismaState(), config: [dotenv(), environmentVariables()] })
```

```sh
prisma deploy                         # the root's input from .env, .env.production and their .local files, then the shell
prisma deploy --environment staging   # the same files for staging, then the shell
prisma dev                            # the files for dev, then the shell
```

# Non-goals

- Catching a branch on an input field. A truthiness check, `typeof` or `===` between two values sees an object and always goes the same way. It cannot vary the graph, and the design does not try to catch it.
- Letting `destroy` run without a configuration that satisfies the root's schema.
- Treating `KEY=` in a `.env` file as unset for the root's input. The root receives the empty text.
- Leaving Composer's own credentials out of `environmentVariables()`.
- What design section 11 lists outside this project: deprecating `envParam()`, a runtime config source, `doppler()` and other secrets adapters, routing runtime secrets to a secret store, a secret box that survives an ArkType copy, listing an unset `envParam()` among the deploy report's absent keys, and running the deploy through Alchemy's programmatic API.
- A `resolve()` that reads a deploy result.
- Any change to how a service reads its input at boot, beyond the type `service.input()` returns.

# Cross-cutting requirements

- **The four requirements of design section 2 are the acceptance criteria**: a module receives the input it needs and no more; the graph's structure is the same whatever inputs Composer is given; a secret's value never enters deploy state, a generated file, a log, the deploy report or an error message; and if it type-checks, it deploys correctly.
- **A project with neither `config` nor `secrets` reads its values where it did before.** Both lists default to `[environmentVariables()]`. The breaking changes are the ones design section 10 lists, and the release note shows each before and after.
- **Recorded decisions are amended in the same PR as the code that changes their behaviour.** Design section 12 lists the decisions, what this design reverses in each, and the glossary changes. The domain docs (`module-composition.md`, `config-params.md`, `deploy-cli.md`, `local-dev.md`), the guides and the agent skill change in the same PRs.
- Every implementer and reviewer is Opus.

# Definition of done

S2 to S13 meet these conditions. S14 to S16 are designed with Will after S13 and add their own.

**Requirements (design section 2)**

1. A module's body receives a dictionary of values. Passing the whole `input` on fails to compile and fails at Load, for every module.
2. A module's body never receives an input's real data. The deploy's second process refuses to deploy a graph whose node addresses differ from the ones the first process checked.
3. An end-to-end test searches the configuration file, the stack file, the deploy report, the errors and the second process's output for a known secret value, and finds none.
4. Type tests show that a wrong literal, a runtime value in a plain field, a secret pointer in a wrapped text field and a plain pointer in a `secretString()` field each fail to compile, in a module's binding and in a service's binding.

**Sections**

5. `module()` takes `input`, and `provision(module, { input })` binds it. `params`, `paramNeed()`, `secrets` and the module form of `secret()` are gone (sections 3 and 10).
6. `field()` ships from `@prisma/composer/arktype` and `@prisma/composer/zod`, with `secretString()` from both. A pointer has a kind, secret or plain, and is recognised by its brand and the variable it names. `Pointer`, `isPlainPointer()` and `isSecretPointer()` ship. A wrapped field reports the plain field's error message for a missing field and a wrong type (section 3).
7. Schemas see pointers at deploy, with no stand-in values. The deploy refuses an ArkType service schema that loses a secret box, naming the field. `service.input()` returns the schema's output with every pointer removed (section 3).
8. A service's binding is typed from its schema, with `SecretString` and `Pointer` as leaves (section 3).
9. `envParam()`, `envSecret()`, `generatedParam()` and `serviceOrigin()` are values; `envParam()` reads the configuration, and preflight fills a missing `envSecret()` variable from the secrets (sections 4 and 5).
10. A `resolve()` that lists a runtime value or a wrapped field fails to compile, and Load refuses a dependency that is or contains a pointer. `isRuntimeValue()` is gone (sections 6 and 10).
11. The root declares `input`. The deploy binds it to the configuration and checks it with the root's schema before anything is created (section 7).
12. `config` and `secrets` on the `composer` section default to `[environmentVariables()]`. `environmentVariables()` and `dotenv()` ship, and `dotenv()` delegates to a pinned `dotenv-flow` without `.env.defaults`. `deploy` and `dev` run both lists in their first process, `destroy` runs only the config adapters, and no second process runs an adapter (section 8).
13. The deploy's and `destroy`'s second processes read the configuration file, which is mode 0600 and deleted when the deploy ends. `prisma dev`'s second process receives its secrets through its environment, never through a file (section 8).
14. Composer redacts every value under a name an `envSecret()` names and every value the secrets adapters return, at any length, in errors, adapter failures, and the second process's output and failure cause (section 9).
15. `auth()`, `email()` and every example use `input`, with wrapped fields where they bind runtime values. `prisma deploy` and `prisma dev` of the examples work against real targets, including a root `input` from `.env.<environment>` (section 10).
16. The decision records, glossary, domain docs, guides and agent skill describe the new surface, as design section 12 lists (section 12).
