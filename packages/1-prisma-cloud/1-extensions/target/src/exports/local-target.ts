/**
 * The extension's local-target control-plane entry (ADR-0041), a separate
 * entry from `./control`. `control/extension.ts` loads `localTargetDescriptor`
 * through its lazy `localTarget` reference; the descriptor lives in
 * `../local-target/descriptor.ts`. The entry also exposes the emulator
 * registry root, the variable that sets it, and the `listEmulators`
 * operation behind `prisma emulator list`, from `@internal/dev-emulators`.
 */
export type {
  EmulatorInstance,
  EmulatorKind,
  EmulatorList,
  EmulatorListing,
} from '@internal/dev-emulators';
export {
  defaultRegistryRoot as emulatorRegistryRoot,
  EMULATORS_DIR_ENV,
  listEmulators,
} from '@internal/dev-emulators';
export { localTargetDescriptor } from '../local-target/descriptor.ts';
