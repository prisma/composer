#!/usr/bin/env bun
/**
 * Builds the mailer example: the runtime server bundle, plus a precompiled
 * stand-in for `templates.tsx` that the deploy CLI's module-graph loader can
 * read.
 *
 * `prisma-composer deploy` loads `module.ts`'s import graph
 * (`module.ts` -> `service.ts` -> `templates.tsx`) with Node's own ESM
 * loader to build deploy topology. Node's native TypeScript support strips
 * types but has no JSX transform, so a `.tsx` file with real JSX syntax
 * (`templates.tsx`, `emails/welcome.tsx` — this example's react-email demo)
 * can't sit in that graph. Bun's bundler, used below for the runtime
 * artifact, has no such limit.
 *
 * So: compile `templates.tsx` to plain, JSX-free JS first (real npm
 * packages stay external, nothing from node_modules gets inlined — this is
 * a JSX transform, not a bundle), and have `service.ts` import that
 * compiled file instead of the raw source. The runtime bundle below
 * imports the very same compiled file, so there's one wired-up template
 * set, not two.
 */
import { $ } from 'bun';

await $`rm -rf dist/mailer`;
await $`mkdir -p dist/mailer`;

await $`bun build src/mailer/templates.tsx --target=node --format=esm \
  --external arktype \
  --external @prisma/composer-prisma-cloud/email \
  --external react \
  --external @react-email/components \
  --external @react-email/render \
  --outfile dist/mailer/templates.generated.ts`.quiet();

const generated = await Bun.file('dist/mailer/templates.generated.ts').text();
await Bun.write(
  'dist/mailer/templates.generated.ts',
  `// @ts-nocheck -- compiled from templates.tsx by scripts/build.ts; see that file.\n${generated}`,
);

await $`bun build src/mailer/server.ts --target=bun --outfile dist/mailer/server.mjs`;
