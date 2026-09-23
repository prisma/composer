# Alchemy framework builds in Composer (draft implementation)

## Boundary

`@alchemy.run/frontend-frameworks` is a separate public package. Composer's
optional `@prisma/composer/frameworks` entry accepts the published package's
Node-target exports, calls the corresponding builder, and uses Alchemy's Prisma
website artifact staging for every framework.
The base `@prisma/composer` authoring entrypoint does not import a framework runtime.

Composer still owns the App, environment rows, Deployment, state, boot wrapper,
and local emulators. Replacing those with `Prisma.Website.*` would bypass
Composer's typed bindings and create a second resource lifecycle. The
`COMPOSER_<ADDRESS>_ORIGIN` row also depends on the App created before it,
which the Website composite cannot represent without a dependency cycle.
[ADR-0048](../90-decisions/ADR-0048-prisma-cloud-resources-come-from-the-upstream-alchemy-provider.md)
continues to govern deployment; [ADR-0049](../90-decisions/ADR-0049-framework-builds-are-an-opt-in-extension.md)
defines the build exception.

## Implementation

An author opts in explicitly:

```ts
// prisma-composer.config.ts
import { frameworkBuild } from '@prisma/composer/frameworks/control';
import { prismaCloud, prismaState } from '@prisma/composer-prisma-cloud/control';
import { defineConfig } from '@prisma/composer/config';

export default defineConfig({
  extensions: [prismaCloud(), frameworkBuild()],
  state: prismaState(),
});
```

```ts
// src/service.ts
import framework from '@prisma/composer/frameworks';

build: framework({ module: import.meta.url, framework: 'vite', root: '..' })
```

The descriptor is data. During assembly, the extension invokes the published
framework builder directly and reads its `BuildOutput` path and
server entry. The framework type and runtime validation come from Alchemy's
package exports; Composer has no separate framework-name list. Dedicated Node
output goes through Alchemy's Prisma website staging. Vite's Node target serves
static files through Compute. Next.js reports the project root; Alchemy's
staging selects its runtime files and assets without copying that root.
Composer adds its boot wrapper and validates the staged bundle before upload.

`composer dev` uses the same build and assembly, watches the source root,
and excludes generated output and deploy state. It does not use Alchemy's
`dev()` server, because that server has no Composer service bindings or
Postgres emulator. This means full rebuilds rather than native HMR.

## Validation and release gates

Locally verified against published `@alchemy.run/frontend-frameworks@2.0.0-beta.79`
and current framework packages:

| Framework | Builder + Composer artifact | Assembled runtime |
| --- | --- | --- |
| Astro 7 | pending with Alchemy staging | pending |
| Next.js 16 | passed with Alchemy Prisma website staging | page passed |
| Nuxt 4 | pending with Alchemy staging | pending |
| TanStack Start | pending with Alchemy staging | pending |
| Vite 8 | passed | page and health passed |

The checked-in Vite example also passed the real `composer dev` CLI,
including one source-change rebuild without a watch loop. These are local
checks, not cloud-deploy or Windows validation.

The published package also exports Node targets for Octane, React Router,
SolidStart, SvelteKit, Waku, and Vocs. Those targets are accepted by the
extension but have not yet passed Composer runtime and cloud checks. Do not
move their create-prisma templates to this descriptor until they do. In
particular, beta.79's SvelteKit target still calls `generateManifest`, which
SvelteKit 3 removed. Alchemy main uses `generateServerInstance`, but that
fix is not published.

Before changing a create-prisma template: pass cloud deploy and runtime checks
for its exact framework version, dynamic and static routes, typed inputs and
secrets, destroy, and Windows where supported. Upgrade the Alchemy/Effect
dependency set together; mixing the beta.79 frontend package with Composer's
old beta.74 runtime breaks even an unchanged Composer app. Provider
compatibility tests and a cloud deploy must be green before this draft is
mergeable.

## Upstream references

- [Framework contract](https://github.com/alchemy-run/alchemy/blob/b261867f14ff80bcb2cb928d07189953891bb2ad/packages/frontend-frameworks/src/core/Framework.ts)
- [Build output](https://github.com/alchemy-run/alchemy/blob/b261867f14ff80bcb2cb928d07189953891bb2ad/packages/frontend-frameworks/src/core/BuildOutput.ts)
- [SvelteKit Node target](https://github.com/alchemy-run/alchemy/blob/b261867f14ff80bcb2cb928d07189953891bb2ad/packages/frontend-frameworks/src/sveltekit/node.ts)
- [Prisma Website composite](https://github.com/alchemy-run/alchemy/blob/b261867f14ff80bcb2cb928d07189953891bb2ad/packages/alchemy/src/Prisma/Website/FrameworkSite.ts)
