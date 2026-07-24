#!/usr/bin/env node

/**
 * Dependency Cruiser configuration for Prisma Composer (ADR-0028).
 *
 * Derives module groups from architecture.config.json and encodes the
 * same-layer/downward-only semantics for domains and layers, plus the
 * control/execution plane split (ADR-0017). Copied from Prisma Next's
 * implementation (its Package-Layering doc and ADR 140), with two additions:
 * 9-public is a sink (no internal package imports it), and examples plus the
 * integration tests may import only the 9-public packages.
 *
 * Package specifiers are aliased to workspace sources via
 * tsconfig.depcruise.json's `paths`, so the cruiser analyses source-to-source
 * edges (the packages' exports maps point at built dist, which is excluded).
 */

import config from './architecture.config.json' with { type: 'json' };
import { normalizeGlob } from './scripts/architecture-coverage.mjs';

const {
  packages: packageConfigs,
  layerOrder,
  planeRules,
  crossDomainExceptions,
  crossDomainRules,
} = config;

const moduleGroupMap = new Map();

for (const pkgConfig of packageConfigs) {
  const key = `${pkgConfig.domain}-${pkgConfig.layer}-${pkgConfig.plane}`;
  if (!moduleGroupMap.has(key)) {
    moduleGroupMap.set(key, {
      key,
      domain: pkgConfig.domain,
      layer: pkgConfig.layer,
      plane: pkgConfig.plane,
      globs: [],
      patterns: [],
    });
  }
  const group = moduleGroupMap.get(key);
  group.globs.push(pkgConfig.glob);
  group.patterns.push(normalizeGlob(pkgConfig.glob));
}

const moduleGroups = Array.from(moduleGroupMap.values());

const getLayerIndex = (domain, layer) => {
  const order = layerOrder[domain];
  if (!order) return -1;
  return order.indexOf(layer);
};

const describeGroup = (group) => `${group.domain}/${group.layer}/${group.plane}`;
const groupPattern = (group) => group.patterns.join('|');

const matchesGlobPattern = (group, pattern) => {
  return group.globs.some((glob) => {
    if (glob === pattern) return true;
    const normalizedExceptionPattern = normalizeGlob(pattern);
    const normalizedGroupPattern = normalizeGlob(glob);
    if (normalizedExceptionPattern === normalizedGroupPattern) return true;
    const exceptionBase = pattern.replace(/\/\*\*$/, '').replace(/\*$/, '');
    const groupBase = glob.replace(/\/\*\*$/, '').replace(/\*$/, '');
    if (groupBase.startsWith(exceptionBase) || exceptionBase.startsWith(groupBase)) return true;
    return false;
  });
};

const isCrossDomainException = (sourceGroup, targetGroup) =>
  crossDomainExceptions?.some(
    (exception) =>
      matchesGlobPattern(sourceGroup, exception.from) &&
      matchesGlobPattern(targetGroup, exception.to),
  );

const forbidden = [];

const pushRule = (name, comment, sourceGroup, targetGroup) => {
  forbidden.push({
    name,
    comment,
    severity: 'error',
    from: { path: groupPattern(sourceGroup) },
    to: { path: groupPattern(targetGroup) },
  });
};

const createUpwardRules = () => {
  for (const sourceGroup of moduleGroups) {
    for (const targetGroup of moduleGroups) {
      if (sourceGroup.domain !== targetGroup.domain) continue;

      const sourceIndex = getLayerIndex(sourceGroup.domain, sourceGroup.layer);
      const targetIndex = getLayerIndex(targetGroup.domain, targetGroup.layer);
      if (sourceIndex === -1 || targetIndex === -1 || targetIndex <= sourceIndex) continue;

      pushRule(
        `upward-${sourceGroup.key}-to-${targetGroup.layer}`,
        `Upward import: ${describeGroup(sourceGroup)} cannot import from ${describeGroup(targetGroup)} (away from core)`,
        sourceGroup,
        targetGroup,
      );
    }
  }
};

const createCrossDomainRules = () => {
  for (const sourceGroup of moduleGroups) {
    for (const targetGroup of moduleGroups) {
      if (sourceGroup.domain === targetGroup.domain) continue;

      const sourceDomainRule = crossDomainRules[sourceGroup.domain];
      const mayImportFrom = sourceDomainRule?.mayImportFrom ?? [];
      if (mayImportFrom.includes(targetGroup.domain)) continue;
      if (isCrossDomainException(sourceGroup, targetGroup)) continue;

      pushRule(
        `cross-domain-${sourceGroup.domain}-to-${targetGroup.domain}`,
        `Cross-domain import: ${sourceGroup.domain} cannot import from ${targetGroup.domain}. ${sourceDomainRule?.reason ?? 'Domain rule violation'}`,
        sourceGroup,
        targetGroup,
      );
    }
  }
};

const createPlaneRules = () => {
  for (const [sourcePlaneName, planeRule] of Object.entries(planeRules)) {
    if (!planeRule.forbid || planeRule.forbid.length === 0) continue;

    for (const sourceGroup of moduleGroups) {
      if (sourceGroup.plane !== sourcePlaneName) continue;

      for (const forbiddenPlaneName of planeRule.forbid) {
        for (const targetGroup of moduleGroups) {
          if (targetGroup.plane !== forbiddenPlaneName) continue;

          const isException = planeRule.exceptions?.some(
            (exception) =>
              matchesGlobPattern(sourceGroup, exception.from) &&
              matchesGlobPattern(targetGroup, exception.to),
          );
          if (isException) continue;

          pushRule(
            `plane-${sourcePlaneName}-to-${forbiddenPlaneName}-${sourceGroup.key}-to-${targetGroup.key}`,
            `Plane violation: ${describeGroup(sourceGroup)} cannot import from ${describeGroup(targetGroup)} (${sourcePlaneName} → ${forbiddenPlaneName})`,
            sourceGroup,
            targetGroup,
          );
        }
      }
    }
  }
};

const createSinkAndConsumerRules = () => {
  forbidden.push({
    name: 'public-is-a-sink',
    comment:
      '9-public is a sink (ADR-0028): no internal package imports the published packages. ' +
      "One sanctioned exception: the prisma-cloud target's control/extension.ts names its own " +
      "local-target entry's PUBLISHED subpath in a dynamic import (ADR-0041's lazy local-target " +
      'reference — operator directive; naming, operator 2026-07-23) so the production control ' +
      'bundle stays free of local-target implementation code; the specifier resolves at a ' +
      "CONSUMING app's runtime, never as a real build-time dependency between these two packages " +
      '(verified: dist/control.mjs keeps it as a genuine external dynamic import, never inlined ' +
      "— see target's invariant 7 test).",
    severity: 'error',
    from: { path: '^packages/(0-framework|1-prisma-cloud)/' },
    to: {
      path: '^packages/9-public/',
      pathNot: '^packages/9-public/composer-prisma-cloud/src/exports/local-target\\.ts$',
    },
  });
  forbidden.push({
    name: 'examples-import-public-only',
    comment:
      'Examples, the docs website, and integration tests import only the 9-public packages (ADR-0028), so every one is an honest demo of what a user can write',
    severity: 'error',
    from: { path: '^(examples|website|test)/' },
    to: { path: '^packages/(0-framework|1-prisma-cloud)/' },
  });
  forbidden.push({
    name: 'packages-cannot-import-examples',
    comment: 'packages/** cannot import from examples/**, website/**, or test/**',
    severity: 'error',
    from: { path: '^packages/' },
    to: { path: '^(examples|website|test)/' },
  });
};

createUpwardRules();
createCrossDomainRules();
createPlaneRules();
createSinkAndConsumerRules();

export default {
  forbidden,
  options: {
    doNotFollow: {
      path: 'node_modules',
    },
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: 'tsconfig.depcruise.json',
    },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
    includeOnly: '^(packages|examples|website|test)/',
    exclude: {
      // Tests inside packages are excluded (they legitimately cross plane
      // boundaries); build tooling configs are excluded by NAME, deliberately
      // not by a generic `.config.` pattern — the examples'
      // `prisma-composer.config.ts` files are user-facing imports and MUST be
      // cruised (they are how /control extensions enter the deploy, ADR-0017).
      path: [
        'node_modules',
        '^packages/.*\\.test\\.',
        '^packages/.*\\.test-d\\.',
        '^packages/.*\\.vitest\\.',
        '^packages/.*__tests__',
        'vitest\\..*config',
        'tsdown\\.config',
        'next\\.config',
        '\\.d\\.ts$',
        '\\.d\\.mts$',
        'dist',
        'coverage',
        '/scripts/',
      ],
    },
    reporterOptions: {
      dot: {
        collapsePattern: '^packages/[^/]+/[^/]+/[^/]+',
      },
      text: {
        highlightFocused: true,
      },
    },
  },
};
