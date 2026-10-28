# Retros

## 2026-10-28 — final retro at project close

**Outcome.** Track A (full addresses with automatic migration, entry in the config, `prisma deploy list`) shipped in Composer 0.35.0 and prisma 8.0.0-rc.28. B1 (`@<environment>:<address>` in platform commands) merged in prisma-cli. The asks app upgraded in production with no data lost. B2 and B3 were canceled.

**What went wrong.**
1. Stage removal (B2, B3) was planned as part of this project. Root cause: the design discussion started as "should Composer have a `destroy` command?", and the plan kept every outcome of that discussion instead of checking each slice against the purpose. Landed: `.drive/PLAN.md`, "Every slice serves the project's purpose".
2. B2 contradicted pdp-control-plane's recorded decision against a cascading Branch delete. Root cause: the plan was written without reading that repository's specs. Landed: `.drive/PLAN.md`, "Read the owning team's recorded decisions".
3. Close-out had no `.drive/PROJECT.md` saying where long-lived docs go. Landed: `.drive/PROJECT.md`.

**What went right.** The spike checked the three upstream Alchemy assumptions on the real platform before A1 began, and A1's real-platform QA found the platform's bucket-on-new-Branch bug, which the platform team fixed.
