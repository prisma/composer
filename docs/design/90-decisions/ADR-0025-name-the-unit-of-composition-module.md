# ADR-0025: Name the unit of composition "Module", authored with `module()`

## Decision

The unit of composition is a **Module**, authored with a single primitive:

```ts
import { module } from '@prisma/composer';
import catalogModule from './modules/catalog/module.ts';
import storefrontService from './modules/storefront/service.ts';

export default module('store', ({ provision }) => {
  const catalog = provision(catalogModule);
  provision(storefrontService, { deps: { catalog: catalog.rpc } });
});
```

`module()` wraps services, resources, and other Modules, and composes
recursively. The App is the outermost Module — the node you point
`prisma-composer deploy` at. Everything ADR-0014 established about the
primitive's shape (recursive composition, no privileged root, deploy derives
everything from the root node) carries over unchanged; only the noun changed,
from "System" to "Module."

"System" leaves the vocabulary entirely: no construct, type, document term, or
diagram label uses it. Prose may still use "system" as plain English — a large
module may well *be* an inventory system — but the word names nothing in the
framework.

The vocabulary sits in a three-register model. A **package** is the artifact
npm hosts; npm owns that word and we do not rename it. An **extension** is what
you slot into `prisma-composer.config.ts` — deploy targets, build kinds,
anything that extends the toolchain. A **Module** is what you plug together
inside the app. One npm package may register an extension and provide modules;
the registers name roles, not artifacts.

## Reasoning

A unit-of-composition noun has to work at every size a module can be — from an
entire bounded context down to a single wrapped resource — because composition
means most real modules end up small, well below the size of a flagship
example. It has to survive being said constantly, without going stale on
repetition. And it has to fit the sentences developers actually reach for:
"install the ___," "I published a ___," "the auth ___."

"Module" passes all three. It has no size floor or ceiling: "the auth module"
and "a module that provides one cron job" are both ordinary speech, and so is
"your app is the outermost module." It stays invisible under repetition. It
sits naturally in the consuming frames — "install the cron module," "I
published a module" — because npm packages already *are* modules colloquially.
Its prior art is exactly our meaning: a Nest or Angular module is a composable,
boundary-owning unit assembled by dependency injection, and a Terraform module
is a reusable composition with typed inputs and outputs. Nest's own convention
that the root module *is* the app also corroborates "the App is the outermost
Module."

The one real adjacency is ES modules — JavaScript's own `module` — and it
doesn't collide: the language's "module" names a file-grain unit, ours names a
composition-grain unit, and no spoken sentence confuses them ("the cron
module" cannot be misheard as a file). At the authoring surface the collision
is empty too: `module` is a legal identifier at call position, and the
repository is ESM-only, so there's no CommonJS `module` global to shadow.

The evaluation method behind this choice — and behind "System" failing before
it — is simple: say the candidate noun out loud in the sentences developers
actually use (install it, publish it, name a small one, name a big one, use it
next to "service") and check whether every sentence still sounds natural. The
full rubric is recorded in `agent-os/product/vocabulary-tests.md`.

Two rules fall out of this and are worth stating on their own. First,
**identity is the registry's job, not the unit noun's** — "the registry" being
the separate, still-undecided brand name for wherever modules end up published
and discovered, the way Terraform has a Registry for its modules. A branded
unit noun (Hex, or candidates like Prism, Shard, Facet) has to be explained via
the ordinary word it displaced, taxing every composition sentence to buy an
ecosystem signal that belongs on the registry name instead. Second, **a unit
noun must be chosen at the smallest grain**, because composition math puts most
units below any hero example — a noun that only fits flagship-sized units fails
where most of the actual usage is.

## Consequences

- **A repo-wide mechanical rename**, mirroring the rename ADR-0014 itself
  performed: `system()` becomes `module()`, `SystemNode` becomes `ModuleNode`
  (and kin), `system.ts` files and `systems/` directories are renamed, and docs
  prose moves from "System" to "Module." Package names, the CLI, and the
  config file are untouched.
- **"System" must not survive as a term.** The Service-vs-unit ambiguity the
  earlier name asked the glossary to defend against disappears; Service stays,
  unambiguous now.
- **The register model is canon**: package (npm's word) / extension (toolchain
  slot) / Module (unit of composition). Docs introducing a shared capability
  say "the cron module," provided by a package, possibly alongside an
  extension.
- **The registry decision stays deferred**, and gains a shortlist entry: Prism.
  The unit noun no longer carries any identity burden, so the registry name can
  be chosen purely for the identity frames ("it's on ___," "publish to ___").
- **Naming rubrics are now split**: product names use `naming.md`'s value
  tests; vocabulary nouns use `vocabulary-tests.md`'s spoken-sentence tests.
  Neither decides the other's domain again.

## Alternatives considered

- **System** — the name this ADR replaces, chosen on the reasoning that a
  unit-of-composition noun should pass the same tests as a product name. It
  failed once modules got small: "install the cron system" reads as a category
  error in English (a system is something you *operate*, not something you
  install), and "this system uses the cron system and an image-resizer system"
  is barely sayable. The full failure record is in
  `agent-os/product/vocabulary-tests.md`.
- **Component.** A natural word for the unit, and it matches C4's architecture
  sense. Disqualified by a collision one level down:
  a Module *contains* React components in the flagship examples, so "the
  storefront component" is genuinely ambiguous inside one conversation.
- **Gem-style branded nouns (Prism, Shard, Facet, Lens).** Each re-creates the
  identity-tax problem above. Prism is additionally one letter from the master
  brand; Shard already means a database partition, a likely misreading at a
  data company; Facet names an aspect of one surface and can't nest; Lens is
  owned by FP optics libraries in TypeScript. Prism moves to the registry
  shortlist, where a branded identity belongs.
- **Unit, Part, Block, Tile, Cell, Piece.** Fail the install-sentence test ("a
  unit of what?") or read as inert material rather than a boundary-owning
  composition unit; none has prior art in that role.

## Related

- `agent-os/product/vocabulary-tests.md` — the spoken-sentence rubric and the
  "System" failure record.
- `agent-os/product/naming.md` — product-name tests and the register model's
  place in the family story.
- [ADR-0014](ADR-0014-one-authoring-primitive.md) — the single-primitive model
  this renames; its shape stands unchanged, its framework, package, and CLI
  names are superseded by
  [ADR-0026](ADR-0026-name-the-framework-prisma-compose.md).
- [ADR-0003](ADR-0003-deploy-derives-everything-from-the-root-node.md),
  [ADR-0006](ADR-0006-every-node-is-named.md) — the root-node mechanics "the
  App is the outermost Module" rests on.
- [ADR-0016](ADR-0016-a-module-has-the-same-boundary-as-a-service.md) — the
  boundary model, unchanged by the rename.
