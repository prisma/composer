# Naming the family — a proposal

I'd like to propose a holistic naming scheme for the Prisma family that reorients us
away from products with individual identities, like MakerKit, toward a single product
identity built around the **Prisma App** — assembled from focused components that each
serve one purpose.

Here's the whole thing in one breath:

> You build a **Prisma App** by snapping together **Hexes** — reusable building
> blocks you install from a public registry. You wire them together with **Prisma
> Compose**. You deploy it to **Prisma Cloud**, where it runs on **Prisma Compute**,
> its data modeled by **Prisma Data** and persisted to **Prisma Postgres**.

## The family, named by role

The components you compose into a Prisma App:

| Component | Role | What it does for you |
|---|---|---|
| Prisma Compute | execute | my code runs |
| Prisma Postgres | persist | my data has a home |
| Prisma Streams | stream | my events flow and survive |
| Prisma Data | data | I model, query, and manage my data |
| Prisma Compose | compose | my app comes together from parts |

And the platform around them:

- **Prisma Cloud** — where your app is deployed and runs.
- **Prisma Hexicon** — the registry you install Hexes from.
- **Prisma Console** — the view across all your deployments.
- **Prisma Dev** — your whole app, running locally.

## Two renames worth flagging

- **MakerKit → Prisma Compose.** "MakerKit" sounds like a standalone starter kit and
  doesn't sit in the family. What it actually does is *compose* the other pieces into
  an app — so the name should just say that. Prisma Compose belongs.
- **Prisma Next → Prisma Data.** This one's a bigger call, so it has [its own
  write-up](prisma-data-rename.md). Short version: Prisma Next was going to become
  "Prisma 8", but it isn't really the next ORM — it's a different product with a
  different mental model, and a version number would promise a smooth upgrade we can't
  honor (and cap us at "still an ORM"). "Data" names what people actually care about,
  reads clearly to the non-technical, agent-assisted builders we're going after, and
  is broad enough to be more than an ORM. Prisma ORM doesn't go anywhere — existing
  users keep it; new work starts on Prisma Data.

## One product, many components

Right now each product has its own identity — MakerKit, Prisma Next, Prisma Postgres,
Prisma Compute (and in the past, Accelerate, Pulse, Optimize). They read like separate
products that happen to share a logo.

We've seen this firsthand with Prisma Postgres: on its own it has no unique value
proposition — Postgres is a commodity — and our strategy has always been to
differentiate through synergy. **Our product family names should convey that**,
instead of asking each component to stand on its own like a separate brand.

So the naming should **orient around the value people actually want — an App — not the
individual components** that deliver it but mean little in isolation.

The hero, then, isn't any single product. It's the **Prisma App**, and everything else
is a named part of building and running one. Each component name only has to make sense
*in that context* — the way "Compute" and "Data" click the moment you know they're
parts of an app, rather than working as globally unique brand identifiers.

The family means more together than any piece does alone: read the roles top to bottom
and they basically spell out "build an app."

The rule underneath it all: **name each part for what it's *for*, not how it works.**
Only the App has to be a word people identify with — "my app," "my data." The
components just need to be clear in that context: nobody says "my Compute," they say
"my app runs on Compute" — which is exactly right, because Compute is a supporting
part, not the hero. And where a component maps to something you *do*, the name says so —
you **compose** your app with Prisma Compose; the wiring it generates underneath stays
out of the name.

## Why now: building apps fast, with agents

The reason this matters is where app-building is going. We want people — and
increasingly their agents — to assemble apps *fast*:

- **Click Hexes together.** An app is composed from **Hexes** — reusable building
  blocks like auth or billing — not hand-wired from scratch.
- **Pull from a registry of pre-built Hexes.** You (or your agent) grab what you need
  instead of writing it.
- **Lean on Contracts and a simple model.** Each Hex snaps in through a typed
  Contract — a boundary the machine, and the agent, can actually check — so
  composition is safe by construction.

Names have to serve that story: clear, predictable, boring in the best way. An agent
composing an app shouldn't have to decode cute product names, and neither should a
new developer.

## Hexicon: a home for Hexes (like skills.sh)

Hexes need somewhere to live — a place to publish, discover, and install them.
That's **Prisma Hexicon** (hex + lexicon = "the catalog of Hexes"), at hexicon.dev.

The trick is that **we don't have to host anything.** Hexes are just TypeScript
packages, so npm does the hosting — versions, resolution, all of it, for free.
Hexicon is the thin, valuable layer on top: search, ranking, trust, and a
one-command install. It's the same split as skills.sh — decentralized hosting plus a
named directory everyone goes to. And unlike a plain package, installing a Hex
doesn't just download it — Prisma Compose wires it into your app.

The registry is the flywheel: the more Hexes people publish, the more valuable the
whole thing gets. That's the part I'm most excited about.

## Prisma Dev: your whole app, locally

**Prisma Dev** runs your entire app on your laptop while you build — a local
emulation of everything Prisma Cloud provides. Under the hood it leans on Alchemy to
stand up local stand-ins for Compute, Postgres, Streams, and the rest, so local dev
matches production without you wiring anything up. Build and test the whole thing
before it ever ships.

## So, the pitch

One identity — the **Prisma App** — with components named for what they do in
context. Rename **MakerKit → Prisma Compose** and **Prisma Next → Prisma Data**.
Build **Hexicon** as the Hex registry (hosting stays on npm). And **Prisma Dev** to
run it all locally.

Thoughts? 🙂
