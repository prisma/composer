/** Public surface (the `./report` subpath): what the generated stack file wires into the alchemy child — the deployment report renderer and the failure-cause capture. Implementation lives in `../render-deployment.ts` and `../deployment-summary.ts`. */
export { captureEngineFailure } from '../deployment-summary.ts';
export * from '../render-deployment.ts';
