/**
 * What the deploy writes and boot reads for a service: the input document and its markers, and the `COMPOSER_` row keys and per-key param pointer rows beside it.
 */
export {
  collectPlatformMarkers,
  decodeVariableText,
  describeDocument,
  escapeKey,
  GENERATED_MARKER,
  type GeneratedMarker,
  generatedMarker,
  isGeneratedMarker,
  isPlatformMarker,
  PLATFORM_MARKER,
  type PlatformMarker,
  type PlatformMarkerUse,
  platformMarker,
  type ReadDocument,
  type ReadDocumentOptions,
  readDocument,
  requiredParamUnsetMessage,
  unescapeKey,
  withUnsetVariables,
} from '../document.ts';
export {
  addressKeySegments,
  composerKey,
  decodeParamPointer,
  encodeParamPointer,
  INPUT_KEY_NAME,
  isParamPointerRow,
  ownKeyPrefix,
} from '../env-keys.ts';
