/**
 * `@internal/streams`' authoring surface: the durable-streams contract, the
 * `streams()` module, and its service node. The runtime adapter
 * (streams-entrypoint) and the local stand-in (testing) stay OUT of this
 * barrel, so a consumer graph that imports this module never bundles a
 * `bun`/`node:` token or the server runtime.
 */
export type { StreamsConfig, StreamsContract } from './contract.ts';
export { durableStreams, streamsContract } from './contract.ts';
export { streams } from './streams-module.ts';
export { streamsService } from './streams-service.ts';
