/**
 * Public surface: local dev's own control-plane subpath (ADR-0041) — the
 * dev stack module's orchestration point, `devProviders`, plus the seam
 * types re-exported here for convenience (they stay DEFINED in
 * `app-config.ts`, since `ExtensionDescriptor.dev` references them as
 * contract). Nothing dev-flavored is exported from `/deploy` or the root.
 */

export {
  DEV_DIR,
  type DevAttachInput,
  type DevAttachment,
  type DevEmulatorsInput,
  type DevExtensionDescriptor,
  type DevProvidersInput,
} from '../control/app-config.ts';
export { devProviders, resolveDevDescriptors } from '../control/dev.ts';
