# What went wrong before: Prisma's pull requests to Alchemy and Distilled

This is a dated record, compiled 2026-11-27 from the pull requests themselves and from two agent sessions' transcripts. It is evidence for the reasoning in [SKILL.md](../SKILL.md), not a rulebook: the upstream repositories' own guidance has changed in response to several of these incidents and will change again. Read it to recognise the pattern you are about to repeat. Add to it when a maintainer pushes back on something new, with the date, the link and their words.

Quotes are the maintainers' own words from the public pull requests named, unless they say otherwise. Pull request numbers are in alchemy-run/alchemy unless they say `distilled#`.

## Contents

1. Invented instead of copied
2. Tests that did not deploy
3. The wrong layer, or the wrong repository
4. Work the maintainers were already doing another way
5. More than one change, or unfinished work, in a pull request
6. Descriptions
7. Neglect after opening
8. Ownership: what a provider may touch
9. Working from outside their repository
10. Treating their repository as ours
11. Assuming control of a pull request
12. Things said about GitHub without checking
13. What went well

## 1. Invented instead of copied

- #416 (first Prisma provider, 45,000 lines, 68 days to merge). The maintainer made 12 commits on our branch to fit it to the repository: binding names changed to mirror another provider's ("align connection surface with repo conventions"), helper functions dropped, resource names made optional and generated, tests moved to their runner, teardown support added after 88 leaked test projects were found.
- #416. Resource named `Prisma.ComputeApp`. "Is this the official name? Is it a container? A fleet? A severless function?" Renamed `Prisma.Compute`.
- #416, #1061. `process.env` in example and doc code, raised twice two months apart: "`process.env` couples everything to node. All code should be written against `effect/Config` instead. Users can do whatever they want, but don't encourage the wrong way of accessing the environment." It later became a written rule and a lint rule.
- #1061. An option on `providers()` so Composer could pass local providers in. "This isn't something we typically do ... The user shouldn't provide them. If they want to override them, they can construct a new layer." Removed; the existing dual-provider mechanism, merged five days earlier, was the answer.
- #1061. A Promise-based database driver ("Please use effect SQL instead of the async api"), a hand-written error class ("Use `Data.TaggedError`?"), and a binding that mapped values to environment variables by hand with a branch per host platform ("This looks wrong. You don't need to map to environment variables or bindings yourself. See s3 example"). Our own summary of that round, on the pull request: "invented instead of followed".
- #1061. A resource without bindings. "Right now, your PR only considers the non-effectful DX. Every resource needs effectful bindings for interacting with it." About 1,800 lines were added to the same pull request. The same point was made on #416 about an Effect-native form for compute.
- #1061. `Prisma.BucketKey`: "Why not call it `Prisma.AccessKey`? ... Maybe `Prisma.BucketAccessKey`?" Not acted on; five days later: "I still think it should be named BucketAccessKey". Two other questions from the same day went unanswered for eight days.
- #2154. A literal version range where every dependency uses the workspace catalog. "Why can't we just update the catalog? I prefer the repo to be consistent".
- #1849. A `logicalId` prop the user had to repeat. "Why are you adding a property `logicalId`? The `"web"` in `Prisma.App("web"` is the logical Id."
- #3529 (2026-11). A default identifier joined with a separator the platform refuses; the maintainer fixed it by commit on our draft twelve hours after it opened. The default path had never been deployed for real.
- #3529 design (2026-11-24). An agent recommended that a site adopt an existing domain ownership automatically, the operator agreed, and 14 hours later the agent read how four other providers' sites take a domain and had to recommend reversing it. The existing pattern was in the repository the whole time.

## 2. Tests that did not deploy

- #1061. "Don't stub. Deploy a real stack (in fixtures/) that deploys an actual app and then have the tests execute request with `HttpClient`". Our reply afterwards: "When I rewrote the tests against the real endpoints I found some errors that would only have surfaced when users ran it in production".
- #1290 introduced a fake Management API. #1359, #1849 and #2026 used fakes or mocks; the maintainer replaced each with live tests by his own commits. On #2026 our description said the live tests were not run "because they need credentials".
- #1849. The live rewrite found that the API refuses to rebind an identifier and that our read "silently took over the resource and could later delete it".
- #2696 (2026-10-27), 26 minutes after it opened: "**A request for future PRs:** please don't use fake clients, mocked HTTP/SDK responses or direct `reconcile` calls to test provider changes. We've had to rewrite these tests on several PRs now. A fake client only checks the provider against our own guess of how the API behaves, and as this PR shows, the real API often behaves differently." His live test also showed that custom domains were broken on `main` for every user. He pointed at the repository's guidance and skills: "If you point your agent at those before it writes tests, its PRs should land without a rewrite."
- #2018 (maintainer's own, open at the time of writing) deletes the fake Management API entirely, lists three provider bugs the fakes hid, and says: "Tests that need Prisma itself to misbehave ... are deleted rather than mocked."
- #3522 (open draft) says in its own description that it adds a fake "which `AGENTS.md` rules out".

## 3. The wrong layer, or the wrong repository

- #1061. The whole provider called the Management API through a client written by hand inside Alchemy. "you're supposed to generate a distilled SDK ... and use that instead of hand-rolling one here in alchemy."
- distilled#1036. A hand-written S3 client inside the Prisma SDK package. Closed with: "this is not the correct approach". Ten minutes later the maintainer opened the pull request that added the outside-contributor rules, saying they "come from what keeps coming up in contributor PRs".
- distilled#1348 (2026-11). We changed Distilled's shared REST protocol and generator so a response could carry its HTTP status, for one Prisma need, and argued when the maintainer objected. "A user should never really need to think about status codes when using a distilled sdk"; "distilled generates clients from the spec"; "you work at Prisma, if consumers of the api need to know if a create made the resource or not that should go in the API, not a patch in our SDK that adds a value the spec doesn't have." Two days were lost before the change was removed. The pull request template and the rule requiring a signed note from agents were added the same evening as his first objection.
- #1518. A type widening proposed upstream and withdrawn 15 hours later with no comment; a Composer change four minutes later met the need on our side.
- #2701 and distilled#1007 (maintainer's own). Prisma began requiring a domain ownership record and told nobody; the maintainer found the provider broken, fixed it, and asked for an endpoint. Prisma shipped it in two days and was thanked: "that's exactly what we needed". He later closed both of his own pull requests in favour of our #3529, so that one carries an obligation to land.
- distilled#1555 (maintainer's own, 2026-11-27). Prisma's spec marks most of its operations experimental; the maintainers moved all of those to a separate module of the SDK, which changes the imports of every provider file that uses them, including our open drafts.
- 2026-11-24 design session. An agent modelled two platform resources from code on the platform's `main` without reading the platform's design documents, treated intended states (a resource that stays pending, a verification that is retried later) as defects to engineer around, and told the operator how the platform behaved when he was describing its design. Two plan versions and two review rounds were thrown away.

## 4. Work the maintainers were already doing another way

- #2942 with distilled#1036. They had an open issue for the same problem. "we are extracting the s3 client into its own distilled". We answered by restating our case. No reply; they shipped their design in two pull requests within days. Ours is still an open, stale draft, and the work has not been redone on their design.
- #3101. A second way to authenticate. The maintainer asked why the obvious way would not do, opened his own alternative 49 minutes later and merged it in three hours, before we answered. Our real reason, given ten hours later, was accepted and ours merged too.
- #1359. Open for 27 days; the maintainer hit the same bug and fixed it differently on `main`. He then discarded our provider change (which would have moved users' databases to a default they had not asked for) and kept only tests.
- distilled#470. A spec refresh the maintainers' own regeneration overtook. "does that solve your issue?" was never answered; closed eight days later. The patches it carried were still needed, and a maintainer ported them himself.

## 5. More than one change, or unfinished work, in a pull request

- distilled#1036 bundled a correct signer fix with the rejected client. The fix was lost with the close and redone by a maintainer four days later.
- distilled#1348's description said it broke the one-change rule "on purpose, so the Alchemy team reviews one Distilled pull request for this work instead of two."
- #1012, #1013, #1015: three pull requests opened in 38 minutes for one piece of work, then consolidated.
- #1290. Opened as a draft with "Changes so far" and "Remaining (why draft)", dependent on an unmerged Distilled pull request, force-pushed seven times in a day, then left for 26 days. The maintainer finished it himself.

## 6. Descriptions

- #1012 and #1061, within 11 and 10 minutes of opening: "Please illustrate the DX in the pr description"; "Can you share sample of DX in PR description".
- Maintainers rewrote the descriptions of at least nine of our pull requests before merging, cutting between a third and seven eighths. Removed each time: top-level headings, lists of commands run and test counts, file-by-file change lists, status reports, long paragraphs about why Composer needs it, agent name lines. Kept or added: one sentence on what the user can now do, one code or diff block, a short list, one line on Prisma's reason, a breaking-change diff.
- Titles were renamed by maintainers to state the exact change in conventional-commit form.
- distilled#1508 (2026-11-26) was the first to use Distilled's template, show the failing call, link the companion pull request and carry the signed agent note. Merged in under eight hours with no comment.

## 7. Neglect after opening

- #1208. "Please merge main into this Pr, resolve conflicts and leave CI in a working state". Nobody acted for 25 days; the maintainer did it.
- #416. Merges of `main` into our branch "resolved conflicts by keeping pre-merge versions — silently deleting whole features main had since landed". The maintainer restored about 50 files by hand.
- Force-pushes to branches under review on #416, #1290, #2154, #2942, #3529 and distilled#1036, some straight after a maintainer's comment.

## 8. Ownership: what a provider may touch

- #416. Our provider's HTTP layer was merged into the stack and replaced the client for every other provider; any stack with Prisma and Cloudflare together hung on deploy.
- #1359, #1582. Omitted props were treated as "must be unset" and then as "set to the default". The accepted behaviour: "Omitted branch props leave the observed attachment alone".
- #1849. A resource found by identifier was treated as owned. Accepted behaviour: owned only when provably created by this stack, otherwise it needs adoption.

## 9. Working from outside their repository

- 2026-11-24 to 11-27. A Composer session did the Alchemy and Distilled work in clones under its own `wip/` folder. Neither it nor its 97 subagents loaded the upstream guidance as project instructions; briefs said "read AGENTS.md" and subagents searched it for a few words. One reviewer applied Composer's review checklist to Alchemy code. Distilled's contributor rules were first read one minute before the pull request was created, after an earlier brief had told an implementer to generate from an unpublished spec file, which those rules forbid. The operator's instruction afterwards: do not change their repository from a subdirectory; start a new agent session in a checkout of their repository, so the agent picks up their directives as a whole.
- Same session. A brief allowed a dependency install inside Alchemy's Distilled submodule. It created a second copy of a core library in 136 folders and broke the type check. A reviewer told to change nothing then reinstalled while another reviewer was running tests in the same checkout, and every test failed.

## 10. Treating their repository as ours

- #1849. Our Distilled pin move pulled in unrelated SDK changes that broke two other providers' type checks. The maintainer re-pinned to a branch of his own.
- 2026-11-24. Briefs from our side told agents to type-check the whole Alchemy workspace, as Alchemy's guidance tells its own agents to. It ran at least 14 times in a day on the operator's machine and reported errors in other providers' code.
- #3529 (2026-11). The pull request pointed Alchemy's Distilled submodule at a commit on our fork, which nobody else can fetch. After our Distilled changes merged, an agent proposed moving the pointer to Distilled `main` (more than a hundred commits of other people's changes) and testing what broke, then defended that over five messages. The operator's ruling: testing that is not our job; we are external contributors who maintain only the Prisma components. The plan had come from a previous session's handover, followed without question. The same agent twice asked the operator to mark that pull request ready in that state.
- #3101. The maintainer made the Distilled pin commit on our branch himself.
- Alchemy's own skill for provider work (read 2026-11-27) tells its reader to land the Distilled change, then move the pin to the merged commit and commit it. It is written for the maintainers' agents and does not mention outside contributors. The operator's decision, 2026-11-27: we assume it applies to us and move the pin to the exact merged commit, until a maintainer tells us not to, because the move is from one of their commits to another. No maintainer has said otherwise as of that date. Record it here if one does.

## 11. Assuming control of a pull request

- distilled#1348 (2026-11-26). We held finished work in a draft for 18 hours, waiting to add a regeneration. A maintainer marked the draft ready and merged it eleven minutes later, with no review. A second Distilled pull request became necessary. The agent's watch on the pull request had died at an app restart and was not restarted; the operator learned of the merge three hours late. The same day a second merge went unnoticed for seven hours, for the same reason.
- Up to this date no maintainer had submitted an approving review on a Prisma pull request. They merge their own work within minutes to hours and ours when it is right.

## 12. Things said about GitHub without checking

- 2026-11-26. An agent's `gh pr create` printed a permission error; the agent told the operator "it changed nothing on GitHub". The pull request had been created. The operator ran the same script three times for one pull request, because it was not safe to run twice and did not say which login or terminal it needed.
- The same session recorded, as a lesson for later agents, that a pull request "had been merged early because it was not a draft". It had been a draft.

## 13. What went well

- Small, single-purpose changes with a description that leads with a diff or a real failure merged without comment: #1703, #1920 (opened with real error output and 48 hours of measured data), #2257, distilled#1508.
- Changing our own API when a maintainer asked (the domain ownership endpoint) was thanked and unblocked their work in two days.
- A real technical reason, stated plainly, was accepted on #3101 even after the maintainer had built an alternative.
