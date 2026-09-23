import { standaloneServerPath } from '@internal/nextjs/control';
import { type NextjsFrameworkBuild, nextjsBuildDescriptor } from './nextjs.ts';

export function nextjsStandaloneServerPath(build: NextjsFrameworkBuild): string {
  return standaloneServerPath(nextjsBuildDescriptor(build));
}
