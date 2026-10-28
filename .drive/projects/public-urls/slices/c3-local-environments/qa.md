# C3 — manual QA, 2026-10-28

A copy of `examples/bucket` with a raw Postgres database added, run with the repo's `prisma` 8.0.0-rc.26 host and this branch's packages. Emulators ran in their own folder.

| Step | Result |
| --- | --- |
| `prisma dev --detach` and `prisma dev --environment test --detach` at once | Both ready; service on 3002 and 3003, separate databases and buckets |
| `prisma dev url bucket-example.blobs`, and with `--environment test` | `http://localhost:3002` and `http://localhost:3003`; both answer |
| Data in dev, then `prisma dev --environment test --fresh --detach` | dev keeps its object and row; test is empty |
| `prisma dev stop --environment test`, then `prisma dev stop` | test stops while dev answers; then dev stops |
| `prisma dev stop --environment nope` | `DEV.NOT_STARTED_HERE`, naming the app and environment; no folder created |
| `prisma emulator list` | Each instance line ends with `(dev)` or `(test)` |
| `--environment Dev` on macOS | `DEV.ENVIRONMENT_NAME_MISMATCH` from `dev`, `dev url` and `dev stop` |
| Upgrade: data written with the released 0.35.0, then `prisma dev` on this branch | Object and row kept; record moved to `.prisma-composer/dev/dev/` at format 3 |

Observed, not fixed here: the build adapter's working folder `.prisma-composer/artifacts/<address>/` is shared by every environment, so two environments starting at once write to it together.
