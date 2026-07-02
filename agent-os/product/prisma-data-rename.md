# Renaming Prisma Next → Prisma Data

## The decision

At GA, **Prisma Next becomes Prisma Data** — not "Prisma 8", which was the original
plan. Prisma ORM keeps its name and continues to serve everyone already on it; Prisma
Data is the product we point new work at.

## Why not Prisma 8

A version number is a promise of continuity — Prisma 7 → 8 tells people "same thing,
here's your upgrade path." Prisma Data can't honor that promise:

- **It's a different product, not a drop-in upgrade.** It asks users to learn a new
  mental model. Any compatibility we shim on top would be a lie that leaks — the
  interface might match, but the behavior won't, and that mismatch surfaces as subtle,
  hard-to-trace differences rather than honest errors.
- **A version number caps the ambition.** "Prisma 8" says "still the ORM." Prisma Data
  is more than an ORM, and the name should fit what it's becoming, not what it evolved
  from.

Forcing Prisma Next into a Prisma 8 shape is also a large, painful compatibility
project — one we take on only to ship a name that misrepresents the product.

## Why "Data"

- **It names the user's value, not the machinery.** People say "my data." For the
  non-technical, agent-assisted audience we're going after, "data" is the one word
  they already own — where "ORM", "schema", and "contract" are noise.
- **It's a superset of "ORM", which keeps our options open.** "Data" is broader than
  "ORM", so the name gives us room to be more than a query layer. A version number
  would have locked us into the ORM category.
- **It fits the Prisma App family.** Read in context, "Data" is simply the data
  component of the stack — the way "Compute" and "Postgres" read as parts of an app.

## It fits the company pivot

Decoupling "Prisma" from "Prisma ORM" is a direction the company has already
committed to: the goal is to pivot toward **Prisma Apps** and capture the fast-growing
market of people — often non-technical — building apps with agents (Lovable, Bolt, v0,
and the like). That audience already dwarfs the number of humans hand-writing apps on
the ORM. This rename is one move in that larger shift, not a standalone branding
exercise.

Because of that, this is **not** about continuity for existing ORM users. They lose
nothing — Prisma ORM stays.

## Living alongside Prisma ORM

We can't retire the ORM — seven major versions are in the wild and will be forever.
What we can do is steer new attention: update the docs and website, make Prisma Data
the default, and add deprecation notices.

The routing between the two is **temporal, not functional** — they overlap in what
they do, so we don't pretend a capability boundary that isn't there:

- **Already using Prisma ORM?** Keep going. You're supported. (No migration nudge —
  we're not pushing anyone onto a different mental model.)
- **Starting today?** Use Prisma Data — it's how you query, migrate, and model your
  data now.

## How we talk about it

Two audiences, two messages — kept deliberately separate:

- **To the builder (adoption):** the value is the outcome — *define your data once, and
  it's instantly a typed, queryable, wired-in part of your app.* Plainer still: "your
  app's data, handled." Don't mention ORMs or categories; just offer the easy path.
- **To the technical evaluator (differentiation):** Prisma Data is not an ORM. The
  proof is the Contract — a machine-checkable definition of your schema that the rest
  of the app, and the agent building it, can build against. That's the mechanism, not
  the headline: lead with the outcome, keep the Contract as the reason it holds.

Keeping "not an ORM" visible to technical evaluators is what segments the market —
query builders compete on ORM terms, and Prisma Data isn't playing that game.
