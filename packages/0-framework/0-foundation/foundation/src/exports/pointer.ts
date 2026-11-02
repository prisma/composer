/** Public surface: the pointer a value known only at boot holds at deploy. Implementation lives in `../pointer.ts`. */

export type { POINTER_TYPE, Pointer, PointerKind } from '../pointer.ts';
export { isPlainPointer, isSecretPointer, POINTER } from '../pointer.ts';
