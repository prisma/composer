/**
 * The extension's local-target control-plane entry (ADR-0041, operator
 * directive; naming, operator 2026-07-23) — a SEPARATE entry from
 * `./control`, loaded only via the lazy
 * `localTarget: () => import('@prisma/composer-prisma-cloud/local-target').then(...)`
 * reference `control/extension.ts` carries. Implementation lives in
 * `../local-target/descriptor.ts`.
 */
export { localTargetDescriptor } from '../local-target/descriptor.ts';
