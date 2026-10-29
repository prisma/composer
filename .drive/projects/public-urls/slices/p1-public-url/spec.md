# P1 — `publicUrl()` with both strategies

Repository: prisma/composer. Parent: [project spec](../../spec.md), [plan, increment 1](../../plan.md). Builds on C1 (`resolve()`, Load's second pass, a resource wired at construction), merged as prisma/composer#396 and #398.

Read before this spec: ADR-0060 (the public URL), ADR-0062 (`resolve()`), ADR-0063 (a node depends on an interface or exposes one), the glossary's Ingress entry, [composer-to-platform.md](../../design/composer-to-platform.md), [scenarios.md](../../design/scenarios.md), and design notes 1, 2, 3, 6 and 11.

## 1. At a glance

```ts
import { module, resolve } from '@prisma/composer';
import { publicUrl } from '@prisma/composer-prisma-cloud';

export default module('shop', ({ environment, provision }) => {
  const web = provision(webService);
  const url = resolve([environment.name], ([name]) =>
    name === 'production' ? 'shop.com' : publicUrl.prismaBuild());
  provision(publicUrl({ name: 'site', url, target: web.http }));
});
```

```
$ prisma deploy
shop
├─ site   public-url https://shop.com
└─ web    compute-service svc_123  https://svc_123.cdg.prisma.build

$ prisma deploy --environment pr-42
shop
├─ site   public-url https://svc_456.cdg.prisma.build
└─ web    compute-service svc_456  https://svc_456.cdg.prisma.build

$ prisma dev
! shop.site names the hostname shop.com. prisma dev ignores it and serves the service on its local URL.
```

## 2. What this slice delivers

1. `publicUrl({ name, url, target })`, `publicUrl.hostname(h)` and `publicUrl.prismaBuild()`, exported from `@prisma/composer-prisma-cloud`.
2. A Prisma Cloud descriptor for the public URL node. A named hostname lowers to one `Prisma.CustomDomain`. `publicUrl.prismaBuild()` lowers to nothing.
3. One `DeployedEntity` per public URL, under the node's address.
4. A deploy that names a hostname whose DNS or ownership record is missing fails with the upstream resource's error (§ 8). A hostname change that the platform refuses leaves the old hostname serving (§ 8).
5. Under `prisma dev`, a local stand-in that creates nothing, and one warning per public URL that names a hostname.
6. The guide, the agent skill and an example use it.

## 3. The authoring surface

### 3.1 Types

In `packages/1-prisma-cloud/1-extensions/target/src/public-url.ts`:

```ts
/** Serve the service at a hostname the author names. */
export interface HostnameStrategy {
  readonly strategy: 'hostname';
  readonly hostname: string;
}

/** Serve the service at the hostname the platform gives it. */
export interface PrismaBuildStrategy {
  readonly strategy: 'prisma-build';
}

export type PublicUrlStrategy = HostnameStrategy | PrismaBuildStrategy;

/** What `url` accepts: a strategy, a bare hostname, or a value that resolves to either. */
export type PublicUrlOption = string | PublicUrlStrategy | Value<string | PublicUrlStrategy>;
```

Both strategies are plain frozen objects, so a `resolve()` callback may return them (C1 requires a computed value's result to be plain data). The ADR's scenario 8 reads `url.hostname` from a resolved `HostnameStrategy`; that works because it is a plain object.

The ADR calls these "the two strategies"; `strategy` is the discriminant for that reason. `'prisma-build'` is kebab-case like every other discriminant string in the extension (`'raw-postgres'`, `'s3-store'`).

### 3.2 The functions

```ts
export function publicUrl(opts: {
  name: string;
  url: PublicUrlOption;
  target: DepBinding<typeof rawHttpContract>;   // the exposed HTTP interface, e.g. web.http
}): PublicUrlNode;

publicUrl.hostname = (hostname: string): HostnameStrategy => …;
publicUrl.prismaBuild = (): PrismaBuildStrategy => …;
```

`DepBinding` is whatever single-slot type `DepBindings<{ target: ReturnType<typeof rawHttp> }>['target']` is in core today; the implementer uses that indexed type and adds no new export to core. A reference to an exposed interface whose contract is not `http` (for example an RPC interface) fails the type check; a test proves it.

`publicUrl()` builds the node with core's `resource()`:

```ts
resource({
  name: opts.name,
  extension: PRISMA_CLOUD_EXTENSION_ID,     // '@prisma/composer-prisma-cloud'
  type: 'public-url',
  inputs: { target: rawHttp() },
  deps: { target: opts.target },
  props: { url: opts.url },
})
```

It provides nothing (ADR-0063: a public URL exposes nothing). `rawHttp()` comes from `@internal/http`, which moves from the extension's `devDependencies` to `dependencies`.

### 3.3 Checks at construction

`publicUrl()` throws a plain `Error` naming the public URL's `name` when:

- `url` is `undefined` or absent. Message: `publicUrl("site"): url is required. Pass a hostname, publicUrl.hostname(…), or publicUrl.prismaBuild().` ADR-0060: leaving `url` out is an error.
- `url` is a string or a `HostnameStrategy` that is not a valid hostname (§ 3.4). A value is not checked here; it is checked in Load (§ 4).

`publicUrl.hostname(h)` throws the same hostname error when `h` is invalid.

### 3.4 What a valid hostname is

One rule, in one function `parseHostname(raw: string): string | { error: string }`, used at construction, in Load and in the descriptor:

- Trim, drop one trailing `.`, lowercase. The result is what is stored and sent.
- At least two labels. Each label is 1 to 63 characters of `a-z`, `0-9` and `-`, and neither starts nor ends with `-`. The whole name is at most 253 characters.
- Rejected with a message that says which: a scheme (`https://`), a path, a port, a `*` label, an IP address.

### 3.5 What a bare string means

A bare string anywhere `url` is accepted, at construction or as a `resolve()` result, means `publicUrl.hostname(thatString)`.

## 4. Load

Core resolves `props.url` in the second pass, as C1 specified for every resource's props. Core learns nothing about public URLs.

After Load, the descriptor (§ 5) is the first party that reads the resolved `url`. It normalizes it with one function, `resolvedStrategy(url: unknown, address: string): PublicUrlStrategy`, which:

- turns a string into a `HostnameStrategy` through § 3.4;
- accepts a `HostnameStrategy` whose hostname passes § 3.4, and a `PrismaBuildStrategy`;
- throws for anything else, naming the node's address and what it got: `shop.site: url resolved to 42, which is not a hostname or a public URL strategy.`

The deploy's preflight (§ 6) and dev's preflight (§ 7) call the same function, so a bad resolved value fails before anything is created, in deploy and in dev alike.

## 5. Prisma Cloud lowering

### 5.1 The descriptor

`descriptors/public-url.ts`, registered in `control/extension.ts` under `nodes['public-url']`. A resource descriptor (`kind: 'resource'`), like the bucket's.

It finds the service the slot is wired to through the graph: the edge into this node's `target` slot, followed through module boundaries to the concrete service, as `slotConnectionParams` already does. It reads that service's lowered outputs from `ctx.lowered`.

**For a `PrismaBuildStrategy`:** declares no resource. Returns `outputs: {}` and one entity, § 5.3.

**For a `HostnameStrategy`:** declares one resource:

```ts
yield* Prisma.CustomDomain(resourceId(address, 'domain', hostname), {
  app: serviceOutputs.serviceId,   // § 5.2
  hostname,
});
```

and returns `outputs: {}` and one entity, § 5.3.

The hostname is part of the Alchemy resource id. Changing the hostname is then a new resource and the removal of the old one, so the deploy creates the new custom domain and deletes the old. With the address alone as the id, Alchemy's `CustomDomain` refuses any hostname change ("cannot atomically replace"). ADR-0060 says changing a hostname replaces it; this is how P1 delivers that until P2's RoutingUrl keeps the record and changes its hostname.

### 5.2 Ordering after the promote

The platform refuses a custom domain on an App with no promoted deployment ("App has no promoted deployment"). So `app` must resolve only after the service's deployment is promoted.

The compute descriptor's final phase adds `serviceId: deployment.appId` to its `outputs`. Taking it from the `Deployment`, not the `App`, carries the ordering edge: the custom domain waits for the promote. The `reserve` phase (a dev server, no deployment) adds `serviceId: provisioned.serviceId`. Nothing else reads `serviceId`; adding an output changes no consumer, because consumers pick outputs by their connection's param names.

### 5.3 The entity

One per public URL:

| Strategy | `kind` | `id` | `url` | `details` |
| --- | --- | --- | --- | --- |
| hostname | `public-url` | the custom domain's `customDomainId` | `https://<hostname>` | `{ hostname, status }`, `status` from the resource |
| prisma-build | `public-url` | the target service's `serviceId` | the target service's `url` output | `{}` |

The render keys every entity under its node's address, so `shop.site` is the public URL's identity in the output, as ADR-0057 makes the address every node's identity. `Prisma.CustomDomain` has no `logicalId` field; the platform row gets the address as its `logicalId` in P2, with the RoutingUrl.

### 5.4 What P1 does not do on the platform

- **Adopt a domain the user attached in the Console.** `Prisma.CustomDomain` refuses one it did not create ("not owned by this resource. Import it with explicit adoption"). That error reaches the user unchanged. Adoption arrives with the RoutingUrl resource (U2, P2).
- **Named hostnames on a non-default Branch** until the Alchemy release carrying alchemy-run/alchemy#2696 is pinned (design note 2). § 10.

## 6. Deploy preflight

`runPreflight` (the extension's deploy preflight) calls `resolvedStrategy` for every node of type `public-url`, so a bad resolved value fails before anything is created. It checks nothing about DNS or ownership: that is the platform's job, and P2 makes an unready hostname a normal state (design note 12).

## 7. `prisma dev`

### 7.1 The stand-in

`@internal/local-target` gains `LocalCustomDomainProvider`, registered in `localTargetProviders`. It calls nothing and stores the attributes Alchemy needs: `customDomainId` `local-<resource id>`, the hostname, `status: 'active'`, empty DNS records. Every other phase is a no-op. ADR-0041: local dev runs the same lowering against local providers.

A `prisma-build` public URL needs no provider: it declares nothing.

### 7.2 The warning

Core's `PreflightInput` gains an optional `warn?: (message: string) => void`, beside `report`. `execute-dev.ts` passes one that emits a new dev event `{ kind: 'target-warning', message }`, which `family/commands/dev.ts` reports as `severity: 'warn'`. Deploy passes none.

The extension's dev preflight calls `warn` once per `public-url` node whose resolved strategy is a hostname:

```
shop.site names the hostname shop.com. prisma dev ignores it and serves the service on its local URL.
```

Nothing keys on the environment name `dev`: the local target ignores hostnames in every environment (scenario 12).

## 8. A hostname that is not ready, and a hostname change

Settled with Will, 2026-10-29 (design note 12). P1 builds nothing of its own for either case.

**A hostname with no ownership proof or DNS.** The platform refuses `POST /v1/apps/{id}/domains` with 422, and the deploy fails with the error `Prisma.CustomDomain` raises. With the pinned Alchemy that error is `Prisma Management API request failed (domain-ownership-required)`; alchemy-run/alchemy#2698 makes it name the TXT record, and P1 takes that with a pin bump when it is released. Composer adds no DNS check: from P2 on, an unready hostname deploys and the output says how to finish.

**A change from a serving hostname to one that cannot serve.** The hostname is part of the resource id (§ 5.1), so the change is a create of the new custom domain and a removal of the old one. Alchemy runs every create before it deletes anything a program no longer declares (`Apply.ts`: `executePlan`, then `collectGarbage`), and a failed create stops the apply. So the platform's refusal fails the deploy and the old custom domain is never deleted. A test proves this against the apply engine (AC 10). From P2 on the RoutingUrl changes its hostname in place, so this protection has to be built there (U2, P2).

## 9. Docs, skill, example

- `docs/guides/building-an-app.md`: a "Making a service public" section with the at-a-glance code, the two strategies, a bare string, `resolve()` per environment, and what a named hostname needs before the deploy (the TXT and CNAME records) until hostnames can be declared before DNS.
- `skills/prisma-composer-core-concepts/SKILL.md`: a public URL in the node table and one paragraph.
- `examples/env-param` gains `provision(publicUrl({ name: 'site', url: publicUrl.prismaBuild(), target: echo.http }))`; its service exposes `http: rawHttpContract` if it does not already. Its smoke test asserts the deploy summary has a `public-url` entity under `env-param-example.site` whose URL is the echo service's URL.
- The scenarios file names P1 against scenarios 1, 2 (production half), 5, 6, 7, 12 and 13.

## 10. The Alchemy release

alchemy-run/alchemy#2696 (custom domains on any Branch) merged on 2026-10-27; the latest release, 2.0.0-beta.84, predates it. Design note 2: `publicUrl()` waits for the release that carries it, and is patched under `patches/` only if that release stalls. The slice builds and tests against beta.83, which is enough for every acceptance criterion except a named hostname on a preview. Before the PR opens, the pin moves to the release if it exists; if not, Will decides whether to patch or wait.

## 11. Acceptance criteria

1. `publicUrl({ name, url, target })` builds a `resource` node of type `public-url` with one `target` slot wired to `target` and `props.url`. A non-HTTP interface as `target` is a type error.
2. Omitting `url`, or passing an invalid hostname as a string or to `publicUrl.hostname()`, throws at construction, naming the public URL and the problem.
3. A `resolve()` value for `url` that resolves to a string, a `HostnameStrategy` or a `PrismaBuildStrategy` lowers per § 5; one that resolves to anything else fails the deploy and dev before anything is created, naming the node's address.
4. A `prisma-build` public URL declares no Alchemy resource and reports one `public-url` entity whose URL is the target service's URL.
5. A hostname public URL declares exactly one `Prisma.CustomDomain` whose id contains the hostname and whose `app` resolves from the target service's deployment; it reports one `public-url` entity with URL `https://<hostname>`.
6. A public URL wired to a module's forwarded HTTP interface lowers against the concrete service inside the module.
7. A deploy naming a hostname that the platform refuses fails, and the upstream resource's error reaches the user unchanged (§ 8).
8. `prisma dev` with a hostname public URL creates nothing for it, prints the warning once per public URL, and runs.
9. Live: the example deploys to production and to a preview with a `prisma-build` public URL; the summary shows the entity; the application topology lists the public URL node with an edge to the service's HTTP interface and no other public URL.
10. A deploy that changes a public URL's hostname, where the platform refuses the new custom domain, fails and does not delete the old custom domain. Proved with a fake Management API under the real Alchemy apply engine.
11. Live: a deploy naming a hostname with no records fails as AC 7 says.

## 12. Deliberately out

- `Prisma.RoutingUrl`, pending hostnames, printing records for a pending hostname (P2).
- Adoption of Console-created domains (U2, P2).
- `prisma.build` as an opt-in record (P3).
- Telling the user, in the deploy output, which services have no public URL but are still reachable at their platform hostname (ADR-0060). It needs core to know which nodes are public URLs; recorded in `.drive/deferred.md`.
- A label helper that turns an environment name into a DNS label (ADR-0060 leaves it to the author).
