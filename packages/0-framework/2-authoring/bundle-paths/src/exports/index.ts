/** Public surface. Implementation lives in `../bundle-paths.ts`. */
export type { BundleLinkKind, BundleLinkPlan } from '../bundle-paths.ts';
export {
  assertBundleSymlinksStayInside,
  bundleLinkKind,
  copyTreeVerbatim,
  createBundleLink,
  isWithin,
  planBundleLink,
  repairWindowsDirectorySymlinks,
} from '../bundle-paths.ts';
