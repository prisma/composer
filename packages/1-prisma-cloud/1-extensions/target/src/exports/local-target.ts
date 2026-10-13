/**
 * The extension's local-target control-plane entry (ADR-0041), a separate
 * entry from `./control`. `control/extension.ts` loads `localTargetDescriptor`
 * through its lazy `localTarget` reference; the descriptor lives in
 * `../local-target/descriptor.ts`. The entry also exposes the emulator
 * registry root and the variable that sets it, from `@internal/dev-emulators`.
 */
export {
  defaultRegistryRoot as emulatorRegistryRoot,
  EMULATORS_DIR_ENV,
} from '@internal/dev-emulators';
export { localTargetDescriptor } from '../local-target/descriptor.ts';
