/**
 * What the deploy writes and boot reads for a service: the input document and its markers, and the `COMPOSER_` row keys beside it.
 */
export {
  collectPlatformMarkers,
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
  unescapeKey,
  withUnsetVariables,
} from '../document.ts';
export {
  addressKeySegments,
  composerKey,
  INPUT_KEY_NAME,
  ownKeyPrefix,
} from '../env-keys.ts';
