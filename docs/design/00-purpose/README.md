# Purpose: what is MakerKit?

**MakerKit lets you write an application as connected components and turns it into
a running, deployed system — without wiring infrastructure by hand.**

Each component — a **Hex** — owns its services and resources and exposes typed
**inputs and outputs**; you build a system by connecting one Hex's outputs to
another's inputs. MakerKit turns that model into the resources to provision,
Alchemy provisions them onto a deployment target, and targets like Prisma Cloud
plug in as extension packs.

## What MakerKit owns, and what it borrows

MakerKit's job is **composition** — the Hex model, the typed connections between
Hexes, and the topology they produce. It borrows everything underneath rather than
reinventing it:

- **Alchemy** — the resource model and the provisioning engine.
- **Prisma Next** — data contracts, the interface to data resources.
- **Prisma Cloud** — hosting, as one deployment target (shipped as an extension pack).

## Read next

- [Goals](goals.md) — the concrete aims that deliver this purpose.
- [Guiding principles](../01-principles/guiding-principles.md) · [Architectural principles](../01-principles/architectural-principles.md).
- [Domain model](../03-domain-model/) — Hexes, inputs/outputs, resources, the topology, and how it layers onto Alchemy and Prisma Cloud.
