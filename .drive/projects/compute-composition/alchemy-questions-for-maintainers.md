# Questions for the Alchemy maintainers about the Prisma Compute change

These go with the pull request that turns `Prisma.Compute` into a composition of `Prisma.ComputeService`, `Prisma.EnvironmentVariable`, `Prisma.ComputeArtifact` and `Prisma.ComputeVersion`.

## 1. How many people use the Prisma provider besides Prisma's own tools?

A stack deployed with an earlier `Prisma.Compute` kept its service, environment variables and current version inside that one resource. After this change, such a stack is refused with a clear error: its owner can stay on the earlier release, or forget the old service and deploy a new one with a new URL. Building an in-place upgrade that keeps the old service and its URL would need a way to split one saved row into several, which Alchemy does not have today. Whether that is worth building depends on how many stacks outside Prisma use `Prisma.Compute`.

## 2. Should `Prisma.App` and `Prisma.Deployment` stay as deprecated exports for one release?

The resources are renamed to `Prisma.ComputeService` and `Prisma.ComputeVersion`. State saved under the old type names is still read through type aliases, but the old exports are gone, so a program that names `Prisma.App` or `Prisma.Deployment` stops compiling. Keeping the old names as deprecated aliases for one release would let users upgrade the package first and rename their code afterwards.

## 3. Should the fake-based Prisma suites be converted to live tests?

Most of the Prisma provider's tests run against the package's in-memory fake of the Management API, `packages/integration-tests/test/Prisma/fixtures/FakeManagementApi.ts`. This change adds `fixtures/ComputeCloud.ts`, a fake Compute platform built on it, for the new fake-based suites (`ActiveVersion.test.ts`, `RenamedResources.test.ts`, and the rewritten `Compute.test.ts`). Alchemy's conventions prefer lifecycle tests against the real cloud, and this change found one mistake the fake did not catch: the platform refuses `/` in a service's logical ID.

Pull request #2018 already removes `FakeManagementApi` and converts the Prisma tests to deployed fixtures, but it is written against the older `packages/alchemy/test/Prisma` layout and conflicts with main. Should this change wait for #2018, move its suites onto #2018's fixtures in this pull request, or land as it is and follow #2018 afterwards?
