---
name: upstream-alchemy-distilled
description: >-
  How Prisma Composer, the Prisma Cloud target, Alchemy's Prisma provider (`@alchemy.run/prisma`), the Distilled Prisma SDK (`@distilled.cloud/prisma`) and the Prisma Management API (prisma/pdp-control-plane and its OpenAPI spec) depend on each other, and how to get a change through alchemy-run/alchemy or alchemy-run/distilled as an outside contributor without the maintainers rewriting or rejecting it. Use this whenever work will change or plans to change either upstream repository, how a `Prisma.*` Alchemy resource behaves or what it accepts (as opposed to how Composer uses it), the generated Prisma SDK, or a Management API behaviour that Composer's deploy depends on; whenever a Prisma pull request is open in either upstream repository; and to decide which repository a change belongs in before any code is written, even if the request only says "the provider", "the SDK", "upstream" or "the Alchemy PR". For moving Composer to a new Alchemy release, use `upgrade-alchemy-effect` instead.
---

# Changing Alchemy and Distilled from Prisma's side

## Audience

An agent or engineer on the Prisma side whose work needs something from Alchemy's Prisma provider or the Distilled Prisma SDK. Both repositories belong to the Alchemy team. We are outside contributors there, and we maintain only the Prisma parts.

If you are about to edit a file in either repository from a Composer session, stop and read "Work inside their repository, in its own session" first.

Why this skill exists: between May and November 2026, Prisma's pull requests to these two repositories drew dozens of objections, rewrites and rejections from the maintainers, and several of their contributor rules were written within hours of one of ours. Almost all of it came from a few causes: working without their guidance loaded, inventing where they wanted a copy of an existing pattern, putting a change in the wrong repository, and treating their repositories as ours. [references/history.md](references/history.md) has the incidents. Read it before your first upstream change, and again when a maintainer pushes back.

## The pieces

- **Alchemy** is an infrastructure-as-code engine written with Effect. A program declares *resources*; Alchemy plans and applies them. Composer turns an app into Alchemy resources, and Alchemy runs inside the `prisma` CLI to deploy them.
- A **provider** is a package of resources for one cloud. Alchemy's Prisma provider, `@alchemy.run/prisma`, holds the `Prisma.*` resources that call Prisma's API. A resource may also have **bindings**: the runtime client a deployed app uses to reach it.
- **Distilled** generates a typed Effect client (an SDK) for each cloud from that cloud's published API description. A **patch** in Distilled is a small JSON file that corrects the description before generation. Nobody edits the generated code.
- **PDP** is Prisma's platform, in the private repository prisma/pdp-control-plane. Its **Management API** is what all of the above call, and it publishes its own OpenAPI description.
- Composer's **Prisma Cloud target** and its **lowering** are the code in this repository that map an app's nodes to provider resources. `docs/design/05-prisma-cloud/alchemy-lowering.md` and the glossary (`docs/design/03-domain-model/glossary.md`) define the rest.

## The chain, and who owns each link

Checked 2026-11-27. Each cell says where to check it again.

| Link | Where it lives | Owner | How a change leaves it |
| --- | --- | --- | --- |
| 1. Management API | prisma/pdp-control-plane | Prisma | Deployed to production |
| 2. OpenAPI spec | Published by the API itself (the mirror's fetch script has the URL) | Prisma | Changes when link 1 deploys |
| 3. Spec mirror | A git repository the Alchemy team runs, named in Distilled's `.gitmodules` | Alchemy team | Copies the published spec on a schedule (its workflow file has the schedule; daily when checked) |
| 4. Distilled Prisma SDK | alchemy-run/distilled, the Prisma package: generated code plus patches | Alchemy team; we contribute to the Prisma package | A pull request moves the mirror pin, regenerates, and adds or prunes patches |
| 5. Alchemy Prisma provider | alchemy-run/alchemy, the Prisma package. Alchemy takes Distilled as a git submodule pinned to one Distilled commit (its `.gitmodules`) | Alchemy team; we contribute to the Prisma package | A pull request, then an Alchemy release |
| 6. Composer | This repository. Versions are pinned in `pnpm-workspace.yaml` | Prisma | A pin bump, then a Composer release |

Each link is built from the one before it. Composer is the exception to "only talks to its neighbour": it also uses the Distilled SDK's credentials type directly and calls the Management API itself for a few things, so a Distilled change can reach Composer without an Alchemy change, and Composer's Distilled pin has to match the one the provider depends on.

What follows from this shape:

- **Composer implements no Management API resources itself.** It composes the upstream provider's resources and writes its own only where upstream has none or no API exists behind them. That is a recorded decision: read `docs/design/90-decisions/ADR-0048-prisma-cloud-resources-come-from-the-upstream-alchemy-provider.md` before proposing anything that changes it.
- **Composer depends on two Alchemy things**: the engine (`alchemy`) and the Prisma provider. A fault in the engine or in another provider is their code, not ours. Describe it to the operator as an issue to raise with them; do not fix it.
- **Distilled reflects the published spec.** A patch states only what their current rule accepts as evidence (the spec, a real response, the provider's own docs or client). The maintainers' position, on one of our pull requests: "you work at Prisma, if consumers of the api need to know ... that should go in the API, not a patch in our SDK that adds a value the spec doesn't have."
- **Alchemy calls the cloud only through Distilled.** No hand-written client and no status-code checks in the provider. A missing operation or error type is a Distilled change.
- **The spec's own markings travel down the chain.** For example, operations the spec marks experimental have been moved to a separate module of the SDK, which changes the imports of every provider file that uses them once Alchemy takes that version.
- **A change moves only as fast as its slowest link.** The mirror has its schedule, each upstream pull request waits for a maintainer, and Composer can only pin a release or a preview build. Plan the order before starting and tell the operator how many upstream pull requests it means, counted by their rules. Each costs the maintainers a review. An instruction from our side to keep it to one does not change their rule: say what count their rules produce and why, before starting.
- **Links 1 and 2 are the only ones we control.** When something is hard to express downstream, the cheapest correct fix is usually in our own API or spec.

## Decide where the change belongs

Work this out before writing code, from the top of the chain down. The first link where the needed fact is missing is where the change starts.

Whichever case it is: before offering any opinion on how a platform resource should be modelled, read that resource's design documents in prisma/pdp-control-plane (its `docs/` folder). They define the lifecycle you will model. Code on its `main` is not the design, and states that look like defects, such as a resource that stays pending, are often intended.

**The API must behave differently, or expose something it does not.** Start in prisma/pdp-control-plane. Ship to production, wait for the mirror, then a Distilled pull request, then an Alchemy pull request, then an Alchemy release, then Composer's pins. If the change would break the provider that is already released, ship it so the old behaviour keeps working, have the operator tell the maintainers before it ships, and remove the old behaviour only after an Alchemy release carries the new provider. The maintainers once discovered on their own that a platform change had broken a feature for every Alchemy user.

**The API already does it and the spec says so, but the SDK is older than the spec.** A Distilled pull request that moves the mirror pin and regenerates; their repository has a skill for it. Check their `main` first, because maintainers regenerate too. A regeneration carries every spec change since the old mirror pin, not only the one you came for: say in the description what else it brings.

**The API does it but the spec does not say so** (an undeclared error response, a field that can be null). Prefer fixing the spec in pdp-control-plane: we own it and every consumer benefits. The SDK still has to be regenerated from the new spec afterwards, by the maintainers' own regeneration or by ours, so check their `main` before opening one. A Distilled patch is for a gap we cannot close quickly, with the evidence their rules ask for.

**The SDK's own runtime code for Prisma must change** (its credentials layer, a hand-maintained module in the Prisma package). A Distilled pull request of its own; by their rule it does not share one with a spec fix or a regeneration.

**Only the provider's behaviour or shape must change.** An Alchemy pull request. A change to what a resource accepts or returns is breaking for every Alchemy user, not only Composer, and their conventions say how to mark and explain that. Composer's lowering and its local stand-in providers bind the same resource classes, so they change with it.

**The Alchemy change needs Distilled code newer than Alchemy's pinned commit.** See "The Distilled pin" below before doing anything.

**Only Composer needs something to be different.** First try to meet the need in Composer: build a different Layer, wrap the resource, or write a Composer-owned resource where the recorded decision allows one. An option added upstream to serve our embedding has been refused ("The user shouldn't provide them. If they want to override them, they can construct a new layer."). Go upstream only when the need would exist for any Alchemy user.

**You need an upstream change that is not released, or not merged, to check the Composer side.** Alchemy publishes preview builds of commits and of pull request heads. The `upgrade-alchemy-effect` skill covers pinning one and what it blocks.

**It is none of these.** A change to Distilled's shared core or generator, or to Alchemy's engine, for a need only Prisma has, fits nowhere above; Distilled's written rule is that one provider's rule stays in that provider. Describe the need to the operator as a scenario and say which link you think it belongs to.

## What is ours and what is not

In both repositories we own the Prisma package and its tests, docs and examples. Everything else belongs to the maintainers. Offering to do their upkeep is not a courtesy: it puts our name on changes to code we do not maintain, and it spends the operator's time and machine on work they do anyway.

Their guidance (as read in November 2026) is written for their own agents, who own the whole repository. So it tells its reader to do some things that an outside contributor should not do unasked. On these, the limits here hold, because each comes from what happened when we did it (the history has the incidents). If their guidance ever addresses outside contributors directly on one of them, theirs wins and this skill needs a fix.

- **Moving the Distilled pin past our own change.** Their instruction to move it to the merged commit we follow as written. Moving it further, or testing what a move does to other providers, is theirs. See the next section.
- **Checking the whole repository.** Their guidance says to type-check the whole workspace before a commit. Run the type check for the Prisma package and the test files your change touches. Their CI checks everything else on the pull request, so read it. A whole-workspace run on the operator's machine reports errors in other people's code that we will not fix.
- **Opening early drafts that carry a status report.** Their own agents do this for work in progress. Our drafts have been finished by a maintainer, merged before we were done, or left to rot. Open a pull request when the work is complete.
- **Rebasing at checkpoints.** Once a branch has a pull request, merge their `main` into it and never force-push: maintainers push to our branches, and a force-push discards their commits and their place in the review.

Also not ours: other providers' code, shared core, the generator, the engine, repository-wide configuration, and the lockfile beyond what our own dependency change requires.

When a previous session's handover lists upstream work, check each step against this section before doing it. A handover is a predecessor's plan, not the operator's approval. That covers its working copies and its open pull requests too.

### The Distilled pin

Alchemy pins one Distilled commit for the whole repository. An Alchemy change that needs newer Distilled code cannot build until that pin includes it.

Their skill for provider work tells its reader to land the Distilled change first, then move the pin to the merged commit and commit it. We follow that as written, without asking first, until a maintainer tells us otherwise (the operator's decision, 2026-11-27): the move is from one of their commits to another of their commits, and it is what their own guidance asks for. If a maintainer does say otherwise, do what they say and record it with its date in [references/history.md](references/history.md).

What stays theirs is everything beyond that one step. Move the pin to the exact commit our Distilled change merged as, and nothing later: when one of ours moved it further, it pulled in other providers' SDK changes and broke two of their type checks, and a maintainer re-pinned it himself. Do not test or fix other providers against the new pin. A pin pointed at a commit that exists only on our fork cannot be fetched by anyone else, so it can never merge.

These steps apply the same way to a pull request that is already open.

1. Open the Distilled pull request complete. Build and test the Alchemy change locally by checking the Distilled branch out in your working copy of the submodule without committing the pointer, and keep it on a fork branch with no pull request. Their rules ask a breaking Distilled change to link the Alchemy change that adapts to it: link the fork branch and say its pull request opens once the Distilled change has merged. An Alchemy pull request that cannot build is unfinished work, so it is opened early only if a maintainer asks for it, and then as a draft that says so.
2. Once the Distilled change merges, move the pin to that exact merged commit, in a commit of its own, and say so in the description with the commit's hash. If the pin has to pass over other Distilled commits to get there, check that the Prisma package still builds and its touched tests pass, and name in the description anything in that range that changes the Prisma SDK.
3. Then open the Alchemy pull request. If their CI fails in other providers because of the pin, report that to the operator; do not fix other providers.
4. A pull request that already carries a pointer to our fork is repaired with a new commit that restores their pin, never a force-push.

## Work inside their repository, in its own session

Do not edit an upstream repository from a clone inside a Composer worktree, and do not send subagents from a Composer session to work there. An agent gets a repository's instructions in full only when its session starts in that repository. From anywhere else it gets Composer's rules plus whatever fragments of theirs it happens to search for. That is how a reviewer came to judge Alchemy code against Composer's review checklist, and how Distilled's contributor rules were first read one minute before a pull request was opened.

**How.** Start a new agent session whose working directory is a checkout of the upstream repository, with whatever your harness offers for that, or ask the operator to open one and hand them the brief to paste as its first message. If you can do neither, stop and ask; a subagent pointed at the folder is not a substitute, because it inherits this session's instructions.

**Where.** A clone of the fork we push from, outside every Composer worktree, where the operator keeps such clones (ask once). One checkout per agent: the installed dependency tree is shared state, and two agents in one checkout have broken each other's runs.

**Distilled is its own repository.** Alchemy vendors Distilled as a submodule and its own guidance has its agents patch and regenerate there. For us a Distilled change runs in a session started in a Distilled checkout, so Distilled's contributor rules are loaded. Do not install dependencies inside Alchemy's copy of Distilled: Alchemy's workspace supplies them, and a second install there has broken the checkout.

**Work already in the wrong place.** If a predecessor left clones with commits inside a Composer worktree, move the work, do not continue it there: push its branch to the fork and start the upstream session on that branch. If that branch already has a pull request, push the unfinished work under a new branch name instead, so nothing unfinished lands on a branch a maintainer may merge.

**"Just do it here."** A message that hands you a clone inside the worktree, or says "do that", was written before the operator heard the concern, so it is not yet their decision. Say once what goes wrong without their instructions loaded, offer to write the brief for an upstream session, and ask. Then do what they decide. If they decide on in place, read that repository's guidance in full by hand before touching anything, and say in your report that it was done that way.

**Reading is not editing.** A Composer session may read upstream source, guidance, issues and pull requests to work out which link a change belongs in. It does not edit there and does not propose a resource's shape.

**Two repositories, two sessions.** When a change needs both, the Composer session coordinates: the Distilled session first, then the Alchemy session against the Distilled branch. Record in the project's plan where each checkout is and which session owns it, so a successor does not ask the operator again.

**What stays in the Composer session:** what the work is for, what Composer needs from upstream, the project record under `.drive/`, and the brief. It does not recommend a resource's shape to the operator: what an upstream resource looks like to an Alchemy user is proposed by the upstream session, after its reading, and goes to the operator before it is built. A recommendation made from the platform's side alone has had to be reversed once the existing Alchemy pattern was read.

**The brief** for the upstream session says:

- What the change is for, and the design as our best effort: the purpose is fixed, the mechanism is open to challenge against their code and conventions.
- Where the platform's design documents for the resource are, and that it reads them before modelling a lifecycle.
- The absolute path of this skill's folder, and that it reads `SKILL.md` and `references/history.md` there. Composer's skills are not installed in their repository.
- The limits in "What is ours and what is not".
- That a change to what users declare or see goes back to the operator before it is built.
- That rules meant for pull requests in our own repositories do not carry over: our description style, any line naming the agent, auto-merge, and merging it ourselves. Upstream, the maintainers merge. An independent review before the pull request opens is still worth having, judged against their guidance and not our own review checklist.

**The first things the upstream session does**, before any design opinion or code:

1. Read the repository's agent guidance in full, not by searching it: the root instruction file, what it links for outside contributors, the pull request template if there is one, and the repository's own skills for the kind of change in hand. These files change often. They are the authority on how code, tests, names, commits and descriptions look in their repository, and they win over this skill on all of that.
2. Find where the repository already does the same job (another provider's resource of the same kind, a binding, a test fixture, a credentials layer) and read it. Copy its names, shape and mechanism.
3. Search their open issues and pull requests for the same problem. We once built something they already had an open issue for, and they shipped their own design within days.
4. Check that their `main` has not already fixed it, and check again each time you merge their `main`.

## What the maintainers hold to

These have held across the record so far. Each has its reason, so you can judge a case their files do not cover.

- **Follow what exists; invent nothing.** They value a consistent repository over a locally better idea ("I prefer the repo to be consistent"; "This isn't something we typically do"). A concept, name, option or branch that no other provider has will be rewritten. When you believe a departure is right, say in the description why the existing way is not enough, before they ask.
- **A resource is not finished when it deploys.** They have expected its runtime bindings, and for compute an Effect-native form, in the same piece of work. Find out from their guidance what the resource kind requires and count it before telling the operator the size.
- **Alchemy provider changes are proven by deploying real resources.** No fakes, mocked responses or direct lifecycle calls. Our tests were rewritten as live tests on six pull requests, five of them by the maintainers' own commits, and the live versions found provider bugs on at least four. A failure the real platform cannot be made to produce comes from a fixture that misbehaves, or is not tested. Distilled's testing rules are different; read each repository's own.
- **Live tests need a test account.** Ask the operator for a token to a workspace used only for tests, and where it is kept; never print it; get it before the pull request opens. Do not assume a deploy token you already have points at such a workspace. Their guidance has an account-wide teardown for leaked test resources. Run it only against that test workspace, and only with the operator's yes.
- **A provider leaves alone what the stack did not declare or create.** Omitted props mean "not managed", not "reset to a default". A resource the provider finds but cannot prove it created is not owned until the user adopts it. Nothing a provider provides may change what other providers in the same stack see.
- **Effect throughout**, in source, docs and examples alike, because examples teach users.
- **One change per pull request, by each repository's own definition.** Distilled's is written and narrow: a spec fix and a runtime change are two. A correct fix of ours was lost there because it shared a pull request with a rejected feature, and a description that says it breaks a rule on purpose is read as exactly that. In Alchemy a resource with its bindings, tests and docs has been one change, and one piece of work opened as three pull requests was joined into one by its author soon after.
- **Descriptions are short and say what the user can now do.** In both, the pattern they kept when rewriting ours was one plain sentence, then a code or diff block, a few bullets, and a marked breaking change. They cut status reports, test logs, file lists, long justifications and agent name lines. Use the format their current guidance and template give; the two repositories differ (in November 2026 Distilled had a template with a checklist and required a signed note on anything an agent wrote, while Alchemy forbade checklists, test sections and large headings), so do not carry one's format to the other. Have a reader with none of our context check the description against their conventions before it goes up.
- **Names are theirs.** Name a resource after the platform's own product name. A name suggested as a question is a request: act on it or answer it in the next push.
- **Their decision is the decision.** When a maintainer says they are solving it another way, ask how to fit into their design, then close ours with a line saying why, or redo it on theirs. Restating our case has not changed an outcome so far, and they have shipped their own version within hours. A real technical reason, stated once and plainly, has been accepted.

## How their pull requests move

Plan around what they do, not around what a pull request's state suggests.

- **So far no maintainer has submitted an approving review on one of ours.** They comment, push commits to our branch, rewrite the description, and merge. Keep maintainer edits allowed.
- **A draft is a signal, not a lock.** A maintainer has taken one of our drafts out of draft and merged it minutes later, at a commit we meant to add to. Every commit pushed to a branch that has a pull request must be safe to merge as it stands. If more is coming, it is in the pull request before it opens, or it is a separate change. Unfinished work lives on a fork branch that has no pull request; pushing there is yours to do.
- **They read, run and fix drafts,** and do not chase. Good small changes have merged in under an hour; ones that needed work waited weeks with one comment or none.
- **Keep it mergeable and green.** Merge their `main` when it conflicts. Take their side for every file our change does not own, then check the diff for files we never meant to touch; a merge of ours once silently deleted features from their `main`. Fetch before every push.

Someone has to know when a maintainer acts. Watch each open upstream pull request for comments, pushes, state changes, merges, failed checks and conflicts with their `main`, with whatever your harness offers. Write the watched pull requests into the project's plan, so a session that restarts finds them and sets the watch up again (background commands do not survive a restart). Tell the operator who did what, including when a merge happened with no review.

## Speaking to the maintainers

A maintainer here means someone who merges in that repository. Check who a commenter is before weighing what they say.

Opening, editing, marking ready, commenting on or closing an upstream pull request speaks to another team in the operator's name. Those steps are the operator's, or need their explicit yes each time. Never turn on auto-merge or merge upstream.

- Find out which GitHub account your shell acts as before planning these steps. Work out the whole sequence of operator steps once, in order, as commands that are safe to run twice and that say where to run them, and ask once.
- After any GitHub write that reports an error, read the state back from GitHub before saying what happened.
- When a maintainer asks or requests something, bring the operator the question and a finished draft answer in one message the same day, in the format their rules require for text an agent wrote. A question of ours that went unanswered got its pull request closed, and others waited a week or more. Where the request is a code change inside the agreed design, such as a rename, push it without waiting and say so in the draft. Do not post it yourself.

## When the operator's request and this skill pull apart

The operator may ask for the very thing this skill warns against: finish it in the clone here, keep it to one pull request, make sure nothing else breaks, defend the option, add it to the SDK anyway. They may not have the history in mind when they ask. Say once, briefly, what happened the last time and what you would do instead, and ask. Their answer decides anything on our side: where the work is done, how much we check, what we propose. It does not change the maintainers' rules or decisions. Where the request is something a maintainer has already refused, the next step is the operator raising it with them, not a pull request that tries it again.

## After it merges

A merged upstream pull request changes nothing in Composer until Alchemy releases and Composer's pins move. The `upgrade-alchemy-effect` skill covers the bump. Update the project's plan in the Composer pull request that consumes the release, and tell the platform's owners when a removal there was waiting on the provider.

## Before asking the operator to open or mark ready an upstream pull request

- The work was done in a session started in that repository, with its current guidance read in full in that session.
- It touches only the Prisma package, or each file outside it copies an existing shape and is explained in the description.
- The Distilled pin is at the exact commit our Distilled change merged as (or where a maintainer said to put it), in a commit of its own, and nothing points at a commit that exists only on our fork.
- Alchemy: every behaviour is covered by a test that deployed for real, and you ran the ones your change touches. Distilled: each patch has its evidence.
- It is one change by that repository's definition.
- The description follows their current format, and a fresh reader has checked it against their conventions.
- Nothing in it is unfinished, and every commit on the branch is safe to merge today.
- The pull request is written into the project's plan, and a watch on it is in place.

## What this skill does not cover

- Moving Composer to a new Alchemy release or a preview build: `upgrade-alchemy-effect`.
- How to write a provider, a patch or a test in their repositories: their own guidance and skills, loaded by working there.
- Reviewing an outside contributor's pull request to our own repositories.
- Design decisions inside Composer or the platform: each repository's design documents.
