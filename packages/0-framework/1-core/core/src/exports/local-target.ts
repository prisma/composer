/**
 * Public surface: the local target's own control-plane subpath (ADR-0041;
 * naming, operator 2026-07-23) — the dev stack module's orchestration
 * point, `localTargetProviders`, plus the seam types re-exported here for
 * convenience (they stay DEFINED in `app-config.ts`, since
 * `ExtensionDescriptor.localTarget` references them as contract). Nothing
 * local-target-flavored is exported from `/deploy` or the root.
 */

export {
  DEV_DIR,
  type LocalTargetAttachInput,
  type LocalTargetAttachment,
  type LocalTargetDescriptor,
  type LocalTargetEmulatorsInput,
  type LocalTargetProvidersInput,
} from '../control/app-config.ts';
export { localTargetProviders, resolveLocalTargets } from '../control/local-target.ts';
