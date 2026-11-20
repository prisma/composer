# Composer works with the platform's variable groups: the design

Written 2026-11-20. Revised the same day after review by the architect and the principal engineer; their reviews are in `reviews/`. It is the whole design of this project. It describes what the system does, and names code only where a reader needs it to check a claim. Composer's code was read at `main` commit `12e524d4`.

## 1. Why this project exists

Prisma Cloud is changing how variables are stored and delivered. The change is designed by Ty Hogarth on the platform team; his spec is `projects/compute-env-var-groups/proposal.md` on the branch `chore/compute-env-var-groups-proposal` of `prisma/pdp-control-plane`, and his implementation is on `feat/variable-groups-console`. Neither is merged.

Every released Composer version breaks under the new model in two ways. This project makes new Composer releases correct under it. Will Madden decided on 2026-11-20 that the fixes ship only in new releases: no patch releases on older lines, and no special treatment of old Composer by the platform. Console and the docs name a minimum version.

## 2. The platform's new model

A word on names: the platform's **service** is what Composer's code calls a `Prisma.App`: one Compute service in one environment.

### What it is today

A variable is a row in a project with a `class` (`production` or `preview`), an optional `branchId`, a `key` and a `value`. A row with no branch is the value for the whole class. A row with a branch is that branch's override, and only preview branches can have one. A deployment receives the rows of its class with its branch's overrides on top, copied once when the deployment is created.

### What it becomes

1. **Variable groups.** Every project has a `production` group and a `preview` group, holding exactly the rows the two classes hold today. A project can add up to ten custom groups. A custom group has one rule on the branch's git name: `equals` or `startsWith`.
2. **A branch receives exactly one group.** The production branch receives `production`. Any other branch receives the custom group with the most precise matching rule, or else `preview`. Groups do not combine: a branch on a group named `staging` receives nothing from `preview`.
3. **Service variables.** Values stored on one service. They are set only through the create-deployment request, in a field named `variables`: a string sets a key, `null` deletes it, and a key not sent keeps its stored value. A service has at most 50. Each value is at most 8,192 characters, and the request body at most 64 KiB. They are deleted with their service.
4. **The order a deployment receives values:** every value of its branch's group, then the branch's overrides, then the service's variables. Later wins.
5. **Branch overrides are being removed.** Three months after the platform work merges, a write that names a branch is rejected with 400. Existing override rows keep applying until their branch is deleted, and can still be deleted by id.
6. **A new read.** `GET /v1/projects/{projectId}/resolved-variables?branchId=…` returns the group the branch receives and every key the branch receives, each with `updatedAt`, `isManagedBySystem` and a `source` (`group`, `branchOverride` or `service`). It returns no values and does not paginate. With `serviceId` it also lists that service's variables.
7. **The API answers every client the same way.** Old requests are accepted and return what they return today. `class: preview` now means the `preview` group only.

### What old Composer does wrong under it

Preflight checks each platform variable with `GET /v1/environment-variables?projectId&class&key`, with no branch. It counts a key as present when a row has no branch or has the environment's own branch. It cannot see a custom group. On a branch that receives a custom group:

| The key is in | Preflight says | Result |
| --- | --- | --- |
| The custom group only | missing | 0.39.0: the deploy fails when a service requires the key, and suggests a command that writes to `preview`, which the branch never reads. 0.38.x and older: the deploy copies the developer's local value into a branch override, which replaces the group's value. |
| `preview` only | present | The deploy succeeds and the service starts without the key. The platform reports it running. |
| Either, and the value in the custom group changes | unchanged | The next deploy does not replace the deployment, because the redeploy trigger is the `updatedAt` of the row preflight saw, which is the wrong row. |

Separately, every Composer version writes each service's `COMPOSER_` keys as branch overrides on every preview deploy. When override writes are rejected, every preview deploy fails, in every project.

## 3. What Composer does today

### Platform variables, which the operator sets

Recorded in [the decision that defines platform variables](../../../docs/design/90-decisions/ADR-0064-an-app-declares-its-platform-variables-in-its-root-and-the-deploy-copies-no-local-values.md). The app root declares each one with `variable({ name })`. The deploy never writes one. Preflight (`runPreflight` in `packages/1-prisma-cloud/1-extensions/target/src/preflight.ts`) is the only code that looks up where a value is set. It:

1. collects every platform variable name a service's input reads, and every declared one no service reads;
2. returns with no API call when there are none and the app has no key clashes (see below);
3. otherwise looks up each name with the list call above, eight at a time;
4. refuses a name whose row the platform manages itself;
5. for a name with no row, runs the reading service's own schema without it to decide whether it is required, fails the deploy if it is, and otherwise lists it;
6. returns a map from name to the `updatedAt` of the row it found. The Compute descriptor puts `<name>:updatedAt` into each reading service's deployment triggers, so a changed value replaces exactly the deployments that read it.

A missing variable's message suggests commands. For production: `prisma project env add 'NAME=<value>' --project <id> --role production`. For any other environment: the same with `--role preview`, then with `--branch <environment>`.

Preflight also runs a **key-clash check** for apps upgrading across the release that changed node addresses: it refuses the deploy while a row still holds a key that a different node now owns.

### A service's `COMPOSER_` keys, which the deploy writes

For each Compute service, `serialize` in `packages/1-prisma-cloud/1-extensions/target/src/descriptors/compute.ts` declares one `Prisma.EnvironmentVariable` resource per value the service reads at boot:

| Kind | Key | Value | Written when |
| --- | --- | --- | --- |
| Declared param: the service's port | `COMPOSER_<ADDRESS>_PORT` | A literal | Always |
| Declared param: each dependency's connection params (a URL, a service key, bucket credentials) | `COMPOSER_<ADDRESS>_<INPUT>_<PARAM>` | Usually issued during the deploy | The param has a value |
| Generated value, and each `serviceOrigin()` in the input | `COMPOSER_<ADDRESS>_<PATH>_GENERATED` | A minted secret, or another service's domain | The input declares it |
| Reserved provider param: the keys this service accepts for calls from other services | `COMPOSER_<ADDRESS>_RPC_ACCEPTED_KEYS` | A list; `[]` with no callers | The service exposes something |
| Reserved provider param: the streams key | `COMPOSER_<ADDRESS>_STREAMS_API_KEY` | Minted | The service provides streams and has a consumer |
| Reserved provider param: the service's own origin | `COMPOSER_<ADDRESS>_ORIGIN` | Its platform-assigned domain | Always |

On production each row is written with `class: production`. On any other environment it is written with `class: preview` and the environment's `branchId`: a branch override. `deploy` then creates the `Prisma.Deployment`, ordered after the rows by a helper, `appAfterEnvironment`, with a `triggers` map that repeats every row's value so that a changed value replaces the deployment. The service's input document does not travel this way; it is in the artifact ([the decision that moved it](../../../docs/design/90-decisions/ADR-0065-a-compute-services-input-document-travels-in-its-artifact.md)).

Four facts decide the design below:

1. **Every key belongs to one service.** At boot a service reads only the keys under its own address (`stashRows` in `serializer.ts`). A value that comes from another service, such as its origin or a key for calling it, is copied under the reader's own key at deploy. `prisma dev` already gives each service only its own keys.
2. **A missing key means something, for every key boot reads.** Boot reads every declared param and all three reserved provider params, for every service, whatever the service declares. A missing key reads as "not provided". For the streams key this is a security control: a streams service with no key refuses to boot, where one with a stale key would keep accepting it.
3. **The largest count found is 8 keys for one service** (the auth module's service, and the streams service). A dependency adds 1, 2 or 4 keys by kind; nothing in the code limits the number of dependencies.
4. **Every value is stored in deploy state in plain text**, as a prop of its row and again as a member of `triggers`. Alchemy writes a redacted value's text into state. None is a platform variable's value: the deploy never holds one.

### Other writes

`claimDatabaseUrlKeys` writes the placeholder `-` under `DATABASE_URL` and `DATABASE_URL_POOLED` in both classes of a project, create-only. A separate check, `assertVariableName`, stops an app declaring those names; it does not depend on the placeholder.

### Under `prisma dev`

The local target supplies its own providers for the same resource types. `Prisma.EnvironmentVariable` writes a key into `env.json` in the dev directory. `Prisma.Deployment` builds the child process's environment (`materializeEnv`): the service's own keys from `env.json`, then the port the emulator assigned over `COMPOSER_<ADDRESS>_PORT`, then the platform variables from the app configuration and secrets. A service that runs its build adapter's dev server has no deployment at all: the `reserve` hook runs in place of `deploy`, writes the input document as one more row, and the dev server's environment is built from `env.json` the same way. Only `prisma dev` causes `reserve` to run.

## 4. The design

Four changes. 4.3 and 4.4 are independent of everything. 4.1 and 4.2 are independent of each other.

### 4.1 Preflight asks the platform what the environment receives

**Behaviour.** When the app names at least one platform variable, preflight makes one call: `GET /v1/projects/{projectId}/resolved-variables?branchId=…`. The branch is the environment's own, and for production it is the project's default branch, whose id the deploy already holds. The call goes through the client view of section 4.4, so it carries Composer's headers. An app that names no platform variable makes no call.

From the response:

1. A name is **present** when `data` holds an entry with that key. Its `updatedAt` is the trigger value. The entry's `source` does not matter: a group value and a branch override both reach every service on the branch.
2. A present entry with `isManagedBySystem: true` is refused, with today's message.
3. A name with no entry is **unset**. The rest of preflight (required or optional per service, the findings list, the failure message) is unchanged.
4. `group` names the group the environment receives. Preflight uses it for the hint commands only.

Everything preflight returns keeps its type. `updatedAt` is printed the same way by the old list call and the new read, so on a branch that receives `production` or `preview` the trigger values do not change, and upgrading replaces no deployment for this reason.

**A failed call fails the deploy.** A 404 for the project or the branch, or any other error, stops the deploy with a message that names the call, the status, and the project and branch ids, and says that the platform may not offer this read yet. There is no fallback to the old per-key lookup: the old lookup is what gives wrong answers, and falling back would bring them back without a word.

**A paginated answer fails the deploy.** The read returns everything in one response today. If the platform ever pages it, a release that read only the first page would report the rest missing, and there are no patch releases to fix that. So a response that carries a pagination field or a cursor stops the deploy with a message that says this Composer version is too old for the platform.

**Hint commands** are chosen by the class of the group the environment receives.

| `group.class` | Commands suggested |
| --- | --- |
| `production` | `prisma project env add 'NAME=<value>' --project <id> --role production` |
| `preview` | `prisma project env add 'NAME=<value>' --project <id> --role preview` |
| `custom` | `prisma variable add 'NAME=<value>' --project <id> --group <name>` |

The group's name is quoted for the shell, as the project id is. Two changes from today:

1. **The `--branch <environment>` command is no longer suggested.** It creates a branch override, which the platform is removing.
2. **A custom group gets the new CLI's command.** `prisma project env` cannot write to a custom group. `prisma variable` is not released yet. A custom group cannot exist in production before the platform turns the feature on, and the platform's rollout releases the CLI first. The slice that builds this checks the command's exact spelling against `prisma/prisma-cli` before it merges. If the command has not shipped by then, the hint for a custom group is a sentence naming the group and Console, with no command.

The built-in groups keep `prisma project env` because it works with every CLI version. It is deprecated in the new CLI but keeps working. The hints move to `prisma variable` in a later change.

**A value set on one service is not seen.** The platform lets a user set a variable on one service, through Console's "Save and Deploy". Preflight asks about the branch, not about each service, so:

- a variable a service requires, set only on that service, fails the deploy as missing, and the hint says to set it in the group;
- Console's "Save and Deploy" creates a deployment that Composer does not know. The next `prisma deploy` makes Composer's own deployment live again. When that deploy replaces the service's deployment, the new one receives the stored value. When it does not, the live deployment is Composer's older one, without the value, until the next replacement.

This gap is left open in this project and recorded in `deferred.md`. Closing it is one read per reading service that already exists, with each key's `updatedAt` added to that service's triggers; a service that does not exist yet has no service variables. It is not built now because Composer has no way to declare such a value, so the feature is half a design. The guide says what Composer reads, and that a change made to a Composer service in Console lasts until the next `prisma deploy`.

**The key-clash check keeps its old lookup** in this change. It reads Composer's own override rows by exact branch, so it is correct on any group. Section 4.2 removes it.

**Blocked on a platform defect.** On the platform's implementation branch, a variable created with `prisma project env add --role production` or `--role preview` is stored without a group id. A deployment receives it, but the new read does not list it. Preflight would report it missing, and the hint command would write another row the read cannot see. The platform's own spec forbids such rows; the implementation does not enforce it. 4.1 cannot be released until this is fixed, and the release is checked against a real platform for exactly this case (section 9).

### 4.2 A service's `COMPOSER_` keys travel with its deployment

**Built on a change that is not merged yet.** An open, approved Composer pull request, "an unchanged deploy no longer replaces a service that depends on another service", changes the same code. It takes a consumer's URL for a producer from the producer's `Prisma.App`, where `main` takes it from the producer's deployment. It also renames `appAfterEnvironment` to `appAfter` and makes a consumer's deployment wait for its producers' outputs, so a producer goes live before its consumers. This design assumes that change is merged, and 4.2 is built on top of it.

**Behaviour.** The deploy writes no variable row for a service. The same keys and values go in the `variables` field of the service's create-deployment request, and the platform stores them on that service. Keys keep their names, so nothing changes in how a service boots.

**In Composer.** `serialize` returns a map from key to value in place of a list of row resources. `deploy` passes the map to `Prisma.Deployment` as its `variables` prop. `appAfter` stays, without the rows: it still makes a consumer's deployment wait for its producers. The deployment's `triggers` keep only the `<name>:updatedAt` members for platform variables; the members that repeated each row's value are deleted, because a changed variable is now a changed prop.

With the pull request above merged, no value in the map depends on a deployment: a service's own origin, another service's origin and a producer's URL all come from a `Prisma.App`, which exists before any deployment. So every value is known at plan time on a deploy that changes nothing, and nothing is replaced.

**The map holds only `COMPOSER_` keys.** It never holds a platform variable's value or a user's value. The values are stored in deploy state in plain text, as the rows and trigger members are today; that is no change in exposure, and the new decision record says so in place of the existing claim that no plain text reaches state.

**Every key boot reads is sent on every deploy, as a value or as `null`.** With stored service variables, a key that is simply left out keeps whatever an earlier deploy stored. So for every declared param and every reserved provider param of the service, the map holds its value, or `null` when it has none. `null` deletes the key. A streams service that loses its last consumer is therefore deployed with `STREAMS_API_KEY: null`, and refuses to boot as it does today. A `null` is a literal known at plan time and the same on every deploy, so it never causes a replacement on its own. The platform accepts a `null` for a key it does not hold, and does not count it toward the limit.

**Keys a service used to send are deleted.** A key the service's code no longer declares, such as a removed dependency's params or a renamed generated value, would otherwise stay stored: readable by every later deployment of that service, and counted toward the limit of 50, with no way for the user to delete it. So Composer keeps, for each service, a record of every key it has ever sent, and sends `null` for each recorded key that is not in this deploy's map.

- The record is a Composer-owned Alchemy resource in the deploy state, `PrismaCloud.SentVariableNames` with the ID `<address>.sent-variable-names`, one per service, like the one that keeps a generated value stable (`GeneratedParam`). Its input is this deploy's key names. Its output is every key name it has been given, ever. It holds names, never values. As built, it is registered for the hosted and the local target.
- When the key names do not change, the record does not change, its output is known at plan time, and the map is the same as last time. So the `null`s are stable and replace nothing.
- When the key names change, the record changes and so does the map. That deploy replaces the deployment anyway, because the keys changed.
- The record starts at the first deploy with this version. Before it, Composer wrote rows, and Alchemy deleted the rows of removed keys itself.

The build confirms, with a test that runs the real Alchemy engine, that the record's output is known at plan time when its input is unchanged. If it is not, every service would be replaced on every deploy, and the design goes back to Will.

**The limit of 50 is checked before anything changes.** `serialize` refuses a service whose map holds more than 50 keys that are not `null`, with a message that names the service, the count and the limit. The platform's own error arrives in the middle of a deploy and says only "Quota exceeded for service_variable". Composer cannot count variables a user set on the service in Console; the guide says they count too.

**The upstream provider.** `Prisma.Deployment` in `@alchemy.run/prisma` gains one prop:

```ts
variables?: Record<string, Redacted.Redacted<string> | null>;
```

- The provider sends it unchanged as `variables` in the create-deployment request. It adds nothing and removes nothing. It is never sent on an update, because the platform takes it only when a deployment is created.
- A changed `variables` replaces the deployment. The provider records a salted hash of the resolved map and compares it in `diff`. A value not yet resolved at plan time counts as changed.
- **Declared `variables` with no recorded hash also replaces.** This differs from `triggers`, which records its first hash through an update. An update creates no deployment, so the values would never reach the platform.
- Leaving `variables` unset sends no field, so every existing user of the resource is unaffected.

The generated client `@distilled.cloud/prisma` gains the field on the request type. It is generated from the platform's published production API description, and it can also carry a hand-written patch for a field the description does not have yet. As built, both packages carry the field as `pnpm` patches under `patches/`, and the proposed upstream changes are in `slices/upstream/`.

**Under `prisma dev`.** The local `Prisma.Deployment` provider takes the service's own keys from its `variables` prop, where it reads `env.json` today. A `null` entry is left out. Everything else in `materializeEnv` stays: the emulator's port is still laid over `COMPOSER_<ADDRESS>_PORT`, and the platform variables are still added. A changed `variables` is a changed prop, so a changed value still restarts the service.

A service that runs a dev server has no deployment, so it has no prop to carry the values. For that path only, `reserve` declares a `Prisma.EnvironmentVariable` per value that is not `null`, plus the input document, and the dev server reads `env.json` as today. `reserve` fails with a bug error when the application is not the local one, so this boundary is checked by code: no row can be written to Prisma Cloud. The local `Prisma.EnvironmentVariable` provider and `env.json` stay for this one use.

**The hosted `Prisma.EnvironmentVariable` provider stays registered**, although no hosted code declares the resource any more. Alchemy needs it to delete the rows an older version wrote, on the first deploy and on `destroy` of an environment last deployed by an older version. The code that maps old resource types and ids in the deploy state stays for the same reason.

**What an existing app sees on its first deploy with the new version.**

1. Each service's deployment is replaced once, because it declares `variables` for the first time. The new deployment is created with the service variables.
2. Alchemy then deletes the resources that are in its state and no longer declared: the old variable rows, on production and on preview. Each row is deleted after the old deployment it fed has stopped. A deployment that is still draining open connections holds its rows until a later deploy finds it stopped, so rows can remain visible in Console after the first deploy.
3. While both exist, the service variable wins over the row.
4. On production, the `COMPOSER_` keys leave the user's production group.
5. A row already deleted in Console, or one the platform manages, is skipped (upstream's own delete does this). A row the platform refuses to delete because its recorded identity does not match is removed from the deploy state and reported as a warning that names the key, so one bad row cannot fail this deploy and every deploy after it. As built, Composer registers the hosted `Prisma.EnvironmentVariable` provider through its own layer (`providerForDeletingOldVariableRows()` in `lowering/src/providers.ts`), whose delete catches upstream's `EnvironmentVariableConflict`, logs the warning, and succeeds, so Alchemy drops the row from state.
6. If the deploy is interrupted after the replacements, the next deploy replaces nothing again and finishes the deletes.

Deleting a row by id keeps working after override writes are rejected.

**What is deleted with the rows.** The key-clash check and the code that computes the clashes: with no rows written, two rows cannot collide. One narrow case remains for an app that upgrades directly from a version before the address change: a service whose new key equals another service's old key, and which has no value for it, would receive the other service's old row once. The guide tells such an app to deploy once with any release from 0.35.0 to 0.39.0 first. `asOwnRow` is no longer applied to variables. Build reporting stops listing variable rows, except the deletes on the first deploy.

**Going back to an older Composer** after a deploy with this version is not possible: deploy state then holds a `PrismaCloud.SentVariableNames` resource per service, an older version registers no provider for it, and Alchemy stops while planning, before changing anything.

**Not part of this:** options on `prisma deploy` that set a user's value on a service, which the platform spec proposes as `--variable`. The decision that defines platform variables says the deploy sets no user values until that has its own design.

### 4.3 The `DATABASE_URL` placeholder is removed

The deploy stops writing the `-` placeholder rows. Will's judgement, 2026-11-20: it was hygiene, and Composer apps do not need it.

- `claimDatabaseUrlKeys`, its call when the application is provisioned, and its tests are deleted.
- The check that stops an app declaring `DATABASE_URL` or `DATABASE_URL_POOLED` stays. Those names are still the platform's.
- The code that retires claim rows found in old deploy state stays.
- Placeholder rows already written to existing projects are left alone. Composer never held them in its state.

The placeholder was written because of a recorded belief that the platform fills in a missing `DATABASE_URL` on the first Compute deploy from any ready database in the project. That is not what the platform does: it writes `DATABASE_URL` only when a project is created with a database, or a database is created as the project's default (`wireDefaultDatabaseUrl` and its three callers). Composer creates projects without a database. The three places that state the old belief are corrected: `docs/design/05-prisma-cloud/alchemy-lowering.md`, the decision that adopted the upstream provider, and the header of the deleted file's neighbours.

What changes for a user: a project that was created outside Composer with a default database has a live `DATABASE_URL` in its production group, and every service on production receives it, as on any Prisma Cloud project.

### 4.4 Composer identifies itself on every Management API call

The platform wants to measure which Composer versions are in use. `main` sends `x-prisma-client-name: composer`, `x-prisma-client-version` and `x-prisma-deploy-source` on the calls it makes through its own client and through the Alchemy provider. It does not send them on calls made with the client the `prisma` CLI hands it after `prisma login`, which includes every preflight lookup.

Ty's open pull request on Composer fixes this with a view over the supplied client that adds the three headers to each request and leaves the CLI's own client unchanged. This project takes that change as it is, with him as co-author. The same pull request also adds publishing from release branches and reverses the recorded policy of no patches for older minors; that half is not taken, per the decision in section 1. The two halves share no files.

## 5. What does not change

- How an app declares or reads a platform variable. Nothing in the authoring surface changes, and nothing in core.
- The names of a service's `COMPOSER_` keys, and how a service boots.
- What preflight returns, and the rule for required and optional variables.
- Layering: every change is in the Prisma Cloud target, its lowering, its local target and the upstream provider. Both reviewers checked this and found no lower layer that learns about one target, one kind of connection or one module.

## 6. Order of work and releases

| Pull request | Contents | Can merge to `main` |
| --- | --- | --- |
| 1 | 4.3 placeholder, 4.4 headers | Now |
| 2 | 4.1 preflight | When the new read is live in production with the defect in 4.1 fixed. Every merge to `main` publishes a `dev` build, and the new preflight calls the read on every deploy that names a platform variable. |
| 3 | 4.2 service variables | When the platform accepts `variables` in production and both upstream packages have released the prop. The platform's request schema rejects unknown fields, so an older platform refuses the request. |

Pull request 1 lands first because pull request 2 edits the same preflight code and its call must go through the header view.

Ty asked for a Composer pull request to align his interface against. So pull request 3 is opened as a draft early, with `pnpm` patches standing in for the two upstream packages, and stays a draft until the real releases exist. The upstream work is one pull request on Distilled and one on Alchemy, opened once the platform's field is final.

**Two minimum versions.** 0.40.0 is released when pull requests 1 and 2 are merged. It is the minimum version for projects with a custom group, which is what Console's warning is about. It still writes branch overrides. The release that carries pull request 3 is the minimum version for the day override writes are rejected, and it must be out, with users on it, before that day: three months after the platform work merges. If pull request 3 is ready in time it goes into 0.40.0 and there is one number. This is a consequence Will has not yet confirmed; see section 10.

## 7. Alternatives considered

**Patch releases on older Composer lines.** Rejected by Will. A patch only spares a user the work of a minor upgrade, which they must do anyway before override writes stop. Usage is spread over six or seven lines, Composer cannot publish from an old line, and the recorded policy is no patches for older minors.

**Fall back to the old lookup when the new read fails.** Rejected: it restores the wrong answers silently.

**Send no `branchId` for production and rely on the read's default.** Rejected: the deploy already holds the default branch's id, and sending it removes a platform behaviour Composer would otherwise depend on.

**One read per service, so preflight sees a value set on one service.** Deferred (section 4.1).

**Keep suggesting `--branch`.** Rejected: it creates an override, which is being removed.

**Send a service's complete set of variables, with the platform deleting everything else stored on the service.** Rejected. It would delete values a user set on that service in Console, on every deploy.

**Leave behind the keys a service stops declaring.** Rejected after review: a stale secret would reach every later deployment of the service, and a service that reached 50 could not be deployed or cleaned up by its user.

**Other ways to delete those keys.**

1. *The provider reads the service's current keys before creating the deployment and sends `null` for those under a prefix Composer owns.* A second prop on the upstream resource, one more call per deployment, and a dependency on the new read listing a service's keys correctly.
2. *Composer reads every service's keys before the deploy and passes the stale ones as `null`.* The `null`s disappear from the props once applied, which replaces each such deployment a second time on the following deploy.
3. *The platform takes a "delete every key with this prefix that I did not send" flag.* Atomic, but a new request to the platform, and nothing Composer can build against today.
4. *The provider remembers the keys it sent.* Does not work: Alchemy creates a replacement without the old instance's props or outputs, and every value change here is a replacement.

**Keep each value in `triggers` and pass `variables` with no hash of its own.** No new diff logic upstream, but every value is then stored twice in props. Rejected.

**One variable holding all of a service's keys as JSON.** Rejected: a value is limited to 8,192 characters, which is the reason the input document was moved out of a variable, and it changes how every service boots.

**Composer keeps writing rows, into the branch's group.** Rejected: a group is shared by every branch that receives it, and these values differ per branch.

**A Composer-owned resource for service variables.** Not possible: the platform sets them only through the create-deployment request.

**Hand the dev server its values without rows.** Rejected: core would have to pass every local target a new thing for one target's reason. Rows through the local provider need no core change.

## 8. Where this is recorded when built

Each slice lands its own docs. The decision index says a changed decision is recorded by rewriting its record in place, with the old position moved to "Alternatives considered".

- **With 4.1:** the decision that defines platform variables is rewritten in place: "What Prisma Cloud does", "Deploy preflight", the commands in its example, and the paragraph on scopes.
- **With 4.2:** a new decision record: a service's `COMPOSER_` keys travel with its deployment as service variables. The decision that adopted the upstream provider is rewritten in place: its ordering, change-propagation and environment-variable sections, and its claim that no plain text reaches state. The decision that moved the input document into the artifact: its table of values that stay variables, and its upgrade section. The decision that local dev runs the deploy pipeline: its statements that dependents read each other through lowered variable records.
- **With 4.3:** the `DATABASE_URL` sections named in 4.3.
- **Glossary:** new entries **variable group** and **service variable**, as the platform's terms. Updated: "a variable on the platform", "platform variable" (class row and branch row), "pointer" (`COMPOSER_` rows), and the paragraph that says where names are stored.
- `docs/design/05-prisma-cloud/alchemy-lowering.md`: the resource inventory, resource ids, the lowering graphs.
- `docs/design/05-prisma-cloud/pdp-data-model.md`: groups, service variables, the order of values.
- `docs/design/10-domains/config-params.md` ("one environment variable on the platform"), `local-dev.md` and `docs/guides/running-locally.md`: where a local service's environment comes from.
- `docs/guides/deploying.md`: setting a platform variable under groups; what Composer reads and that a Console change to a Composer service lasts until the next deploy; the first-deploy replacement and when old rows disappear; the limit of 50; going back to an older version; the upgrade path for an app from before the address change; removal of the "set a value for all previews" advice.

## 9. Tests

The principal engineer's review lists every test by file. The ones that decide whether the design holds:

- **4.1:** present, unset and platform-managed names against a fake of the new read; one call however many names and none when the app names none; the default branch id for production; each failure status; a paginated response; hints for all three classes, with a custom group name that needs quoting, and no `--branch` anywhere.
- **4.2, with the real Alchemy engine against a fake platform that records each create request:** deploying twice unchanged creates no second deployment; one changed value replaces only that service; an unprovisioned param and an absent reserved provider param are sent as `null`; a streams service that loses its last consumer is sent `STREAMS_API_KEY: null`; a removed dependency's keys are sent as `null` on that deploy and every later one; a producer is still promoted before its consumer's deployment is created; a service with 51 keys is refused before any request.
- **4.2, the upgrade:** from state written by today's code, each service is replaced once even when its `triggers` are unchanged, the new create carries every value, and each row is deleted after its service's new deployment exists; a row that answers 404 does not fail the deploy; a row refused for a mismatch produces the warning; an interrupted deploy finishes on the next run.
- **No write to `/v1/environment-variables` happens on any platform deploy.** One test, which also covers 4.3.
- **Local:** an artifact service's environment comes from `variables`, leaves `null` out, and keeps the emulator's port and the platform variables; a dev server keeps its rows; `reserve` never writes a `null` and fails outside the local application; a service that switches between the two modes.
- **Upstream, in the Alchemy pull request:** sent unchanged on create; absent sends no field; a changed, unresolved or first-time map replaces; never sent on update; a failed create's error text holds no value.

Only a real platform can check: the defect in 4.1; the read's choice of group by git name; `null` for a key that is not stored; a service variable winning over an override; deleting an override by id after override writes are rejected; and one real upgrade of an existing example app from 0.39.0.

## 10. Open, for Will

1. **Two minimum versions** (section 6). If 4.2's upstream dependencies are late, 0.40.0 ships without it, and a later release is the minimum for the end of branch override writes. The alternative is that 0.40.0 waits for 4.2. Recommended: do not wait, and tell Ty there may be two numbers.

## 11. Facts about the platform's unmerged implementation that the build re-checks

- The defect in section 4.1: rows written without a group id are not listed by the new read.
- The new read lists a key under `branchOverride` when it is both an override and a service variable, although the deployment receives the service variable. Section 4.1 ignores the source, so this does not affect it.
- A `null` for a key that is not stored is accepted, does nothing, and is not counted.
- The create-deployment request rejects unknown fields.
- When a project has no encryption key, the platform drops `variables` without an error. A Composer project gets its key from the state store before its first deployment, so Composer is not exposed.
- The new read is registered as experimental.
