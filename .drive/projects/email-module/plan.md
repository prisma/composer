# Slice plan: email module

> Single-slice project; spec is the contract at `./spec.md` (settled — do not
> amend without a discussion stop). One PR on branch
> `claude/email-module-design-ca0094`. Layout deviation, recorded: spec and
> plan live at the project root, not under `slices/`, because there is exactly
> one slice.

## Validation gates

Per dispatch unless stated: `pnpm --filter @internal/email typecheck`,
`pnpm --filter @internal/email test`, `pnpm --filter @internal/email build`,
repo lint (biome + rules checks) on touched files. D4 and D5 add the
workspace-wide gate: root `typecheck`, `test`, `lint`, dependency-cruiser
layering. D5 adds the deploy smoke (creds via
`PRISMA_DEPLOY_ENV=~/.config/prisma-compose/deploy.env`; never print values).
Implementer confirms exact root script names from the root `package.json`
before first use.

## Dispatches (sequential)

### D1 — package scaffold + authoring surface

- **Outcome:** `@internal/email` exists with the full authoring surface —
  wire contracts, schemas, `defineTemplates`, `emailSender` — typechecked and
  unit/type-tested; no service/store/delivery code yet.
- **Builds on:** spec only.
- **Hands to:** compiled contracts + `EmailSender` typing D2–D4 import;
  spec §"Public API" frozen in code.
- **Focus:** spec fidelity of signatures and schemas; mirror storage's
  package shape exactly; `defineTemplates` literal-key inference proven by
  `contract.test-d.ts`.
- **Completed when:** package gate green; type tests cover the spec's D3
  claims (wrong `data` fails compilation); schema bounds (to 1–50, key
  1–256, limit 1–200) tested.

### D2 — outbox stores + rpc handlers (delivery stubbed)

- **Outcome:** `outbox-store.ts` interface + memory and Postgres stores
  (spec DDL verbatim) + `handlers.ts` implementing `send` (none-mode +
  dedup-on-conflict), `getEmail`, `listEmails` (filters, keyset pagination,
  cursor codec), against a `Delivery` interface stub.
- **Builds on:** D1's contracts.
- **Hands to:** a complete none-mode send/read path D3 plugs real delivery
  into; store interface D4's entrypoint constructs.
- **Focus:** spec §"Service behavior" steps 1–7 exactly; dedup returns the
  original row with no delivery attempt; pg integration test via the repo's
  local-Postgres harness pattern (see storage's).
- **Completed when:** package gate green incl.
  `pg-outbox-store.integration.test.ts`; handler tests cover the spec's
  listed cases.

### D3 — delivery backings + retry policy

- **Outcome:** `delivery.ts` shared policy (3 attempts, 500ms/2000ms, 10s
  timeout, pinned retry classes) + `delivery-resend.ts` +
  `delivery-smtp.ts`, tested against a local fake HTTP endpoint and a
  capture SMTP transport; wired into the D2 send flow.
- **Builds on:** D2's `Delivery` interface and send flow.
- **Hands to:** a send path complete for all three modes.
- **Focus:** header/body shapes and error-string formats verbatim from the
  spec; omit-empty-optionals; fake timers for delay assertions; nodemailer
  only in `delivery-smtp.ts`.
- **Completed when:** package gate green; retry/no-retry matrix tested per
  spec.

### D4 — service, module, entrypoint, testing export, public wiring

- **Outcome:** `emailService()`, `email()` (boundary params/secrets per
  spec, multi-port expose), `execution/email-entrypoint.ts`,
  `execution/testing.ts` (`startLocalEmailServer`), exports files, and the
  `@prisma/composer-prisma-cloud/email` public entrypoint in `9-public`.
- **Builds on:** D2 stores + D3 delivery.
- **Hands to:** a provisionable, locally runnable module for D5.
- **Focus:** copy storage's build/entrypoint mechanics; module boundary
  exactly as spec §"Module factory" (first multi-port + first boundary-param
  module — any framework breakage here is a stop condition, not something to
  work around); public surface matches storage's one-for-one.
- **Completed when:** workspace-wide gate green (typecheck, test, lint,
  depcruise); `module.test.ts`/`test-d.ts` per spec test plan;
  `startLocalEmailServer` round-trips a send.

### D5 — example app, deploy smoke, README, friction filings

- **Outcome:** `examples/email` (root module, consumer with two templates,
  outbox read-back), local tests with no cloud creds, deploy smoke in
  none-mode against real Prisma Cloud, README per spec, friction findings
  filed (gotchas.md entries per repo practice; spec §"Friction findings").
- **Builds on:** D4's runnable module.
- **Hands to:** slice DoD.
- **Completed when:** spec acceptance criteria 1–4 and 6 pass (AC5, the
  manual resend-mode send, is documented as a runbook step, not executed in
  CI); workspace gate green; deploy smoke output captured in the dispatch
  report (resource counts from destroy, not deploy logs).
- **End-to-end requirement (Will, 2026-07-21):** the deploy smoke exercises
  the full consumer chain — an external request to the consumer service's
  own endpoint causes the send (typed template method → send port), and the
  assertion reads the stored email back through the outbox port. The test
  harness never calls the email module's ports directly; the consumer
  service is the entry point, so the demonstration proves the wiring an app
  would actually use. The local no-creds test proves the same chain against
  `startLocalEmailServer`.
- **Example reshape (Will, 2026-07-22, post-slice round):** the example is
  a signup story, not an HTTP proxy over the module's operations — see the
  amended spec §"Example app + smoke harness". The smoke's loop becomes:
  `POST /signup` → `GET /emails/:id` (demo read-by-id) → extract the link
  from the stored body → `GET /verify?token=…` → verified. This proves the
  rendered link end to end, which the previous smoke did not.

## Open items

- (none)
