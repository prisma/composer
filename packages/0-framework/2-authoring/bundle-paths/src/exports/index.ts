/** Public surface. Implementation lives in `../bundle-paths.ts` and `../boot-wrapper.ts`. */
export { buildBootWrapper } from '../boot-wrapper.ts';
export {
  assertBundleSymlinksStayInside,
  bundleLinkStrategy,
  copyTreeVerbatim,
  createBundleLink,
  isWithin,
  repairWindowsDirectorySymlinks,
} from '../bundle-paths.ts';
