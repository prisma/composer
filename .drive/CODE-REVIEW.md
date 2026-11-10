# Code review context

Project-specific review questions for this repo. Both review passes load this file before reviewing a diff, and answer every question below for every file in the diff.

## Cover the whole diff

Review every changed file, not only the product code under `packages/`. CI workflows and actions under `.github/`, scripts under `scripts/`, examples under `examples/`, docs, ADRs, the glossary, skills and the PR title and description all count. A review that read only the source files has not reviewed the PR.

For each file, ask:

- Did I read every added and changed line, and every unchanged line this PR made wrong?
- If this PR edits a line that already held a shortcut or a bad comment, did I flag it? A PR that touches a line owns it.

## Comments

Implementer models write long comments that explain, justify or narrate. Most should not exist.

- Does any comment explain or justify a shortcut? Flag it, and say what the proper code is. The fix is the code, not a better comment.
- Does any comment tell history ("used to", "before this change", "was renamed"), restate what the code says, or narrate a decision? Delete it.
- Does any comment run longer than two lines? Ask what the code cannot express, keep only that, and delete the rest.
- Is a doc comment on something that is not a user-facing interface? Delete it. On a user-facing interface, is it terse?

## Shortcuts

- Is one value hard-coded in two places, such as the app and CI, and kept in step by a comment? Generate it in one place and pass it, or prove the behaviour without a shared constant.
- Does a test or a CI check compare against a constant it also wrote, so it proves nothing about the behaviour? It should exercise the real behaviour, such as signing a challenge with a key instead of comparing the key to a known string.
- Is a special case, workaround or "temporary" path explained by a comment instead of removed or recorded in the project's `deferred.md`?

## CI, workflows and scripts

- Does any `run:` step in `.github/` hold more than one command, or any shell logic: captured output, exit-code checks, `if`, loops, `grep`? Move it into a script under `scripts/` and make the step one line.
- Does a script print a secret, a token or a value it was given? It must not.
- Does every new script follow the existing ones in `scripts/`: TypeScript run with `bun`, a short usage line, plain error messages?

## Wording

- Is every human-readable string plain English that a reader outside the team understands on the first read? That covers comments, error messages, log lines, test names, docs and the PR text.
  - Flag invented or coined terms where a plain description of what happens works.
  - Flag contracted, telegraphic phrasing that has to be read twice.
  - Flag the banned words: "load-bearing", "gate", "smoking gun", "belt and suspenders".
- Does a test name describe the observable behaviour, not the implementation?
- Does any record, guide, comment or PR text state a current choice as a permanent rule, with "never" and no reason? State what is decided, why, and whether it is expected to change. Keep "never" for real invariants, such as a secret never appearing in an error.
- Is any markdown prose hard-wrapped? One paragraph is one line.

## The PR title and description

Read them as a teammate with none of the author's context.

- Does the title say what changes for a user, not name a mechanism?
- Does the description open with a concrete example, such as code and the output it gives?
- Does it state the decision next, then build the explanation step by step?
- Does it end with the alternatives considered, rather than lead with them?
- Does every claim in it match the code?
