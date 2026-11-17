/**
 * A directory whose `prisma dev` state was written before upstream renamed
 * `Prisma.App` and `Prisma.Deployment`: its rows are rewritten under the new
 * types and names before Alchemy reads them, and every other row is left as
 * it was.
 */
import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { renameRetiredComputeRows } from '../retired-compute-rows.ts';

const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function stageDir(rows: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retired-compute-rows-'));
  made.push(dir);
  for (const [file, row] of Object.entries(rows)) {
    fs.writeFileSync(path.join(dir, file), `${JSON.stringify(row, null, 2)}\n`);
  }
  return dir;
}

const read = (dir: string, file: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));

const appRow = {
  status: 'created',
  fqn: 'shop.quiet',
  logicalId: 'shop.quiet',
  instanceId: 'inst-app',
  resourceType: 'Prisma.App',
  props: { project: 'local', displayName: 'shop.quiet' },
  attr: {
    appId: 'shop.quiet',
    name: 'shop.quiet',
    projectId: 'local',
    regionId: 'us-east-1',
    branchId: null,
    latestDeploymentId: null,
    appEndpointDomain: 'http://localhost:3372',
    createdAt: '1970-01-01T00:00:00.000Z',
    logicalId: null,
  },
  bindings: [],
  providerVersion: 0,
  downstream: ['shop.quiet.deployment'],
  removalPolicy: 'destroy',
};

const deploymentRow = {
  status: 'updated',
  fqn: 'shop.quiet.deployment',
  logicalId: 'shop.quiet.deployment',
  instanceId: 'inst-deploy',
  resourceType: 'Prisma.Deployment',
  props: {
    app: 'shop.quiet',
    artifactPath: '/tmp/shop.quiet.tar.gz',
    artifactContentType: 'application/gzip',
    triggers: { COMPOSER_SHOP_QUIET_PORT: { __redacted__: '3000' } },
    portMapping: { http: 3000 },
    start: true,
    promote: true,
  },
  attr: {
    deploymentId: 'dbbe0d12',
    appId: 'shop.quiet',
    foundryVersionId: 'dbbe0d12',
    status: 'running',
    previewDomain: null,
    artifactHash: 'dbbe0d12',
    appEndpointDomain: 'http://localhost:3372',
    createdAt: '1970-01-01T00:00:00.000Z',
  },
  bindings: [],
  providerVersion: 0,
  downstream: [],
  removalPolicy: 'destroy',
};

const variableRow = {
  status: 'created',
  fqn: 'shop.quiet.env.COMPOSER_SHOP_QUIET_PORT',
  resourceType: 'Prisma.EnvironmentVariable',
  props: { project: 'local', key: 'COMPOSER_SHOP_QUIET_PORT', value: { __redacted__: '3000' } },
  attr: { environmentVariableId: 'COMPOSER_SHOP_QUIET_PORT' },
};

test('an App row and a Deployment row are rewritten under the renamed types and names', () => {
  const dir = stageDir({
    'shop.quiet.json': appRow,
    'shop.quiet.deployment.json': deploymentRow,
  });

  renameRetiredComputeRows(dir);

  const service = read(dir, 'shop.quiet.json');
  expect(service['resourceType']).toBe('Prisma.ComputeService');
  expect(service['attr']).toMatchObject({
    serviceId: 'shop.quiet',
    activeVersionId: null,
    serviceEndpointDomain: 'http://localhost:3372',
    url: 'http://localhost:3372',
  });
  expect(service['attr']).not.toHaveProperty('appId');

  const version = read(dir, 'shop.quiet.deployment.json');
  expect(version['resourceType']).toBe('Prisma.ComputeVersion');
  expect(version['props']).toEqual({
    service: 'shop.quiet',
    artifactPath: '/tmp/shop.quiet.tar.gz',
    artifactContentType: 'application/gzip',
    triggers: { COMPOSER_SHOP_QUIET_PORT: { __redacted__: '3000' } },
    portMapping: { http: 3000 },
    start: true,
  });
  expect(version['attr']).toMatchObject({ versionId: 'dbbe0d12', serviceId: 'shop.quiet' });
  expect(version['removalPolicy']).toBe('retain');
});

test('other rows, rewritten rows and a missing folder are left alone', () => {
  const dir = stageDir({ 'shop.quiet.env.COMPOSER_SHOP_QUIET_PORT.json': variableRow });
  const before = fs.readFileSync(path.join(dir, 'shop.quiet.env.COMPOSER_SHOP_QUIET_PORT.json'));

  renameRetiredComputeRows(dir);
  renameRetiredComputeRows(path.join(dir, 'missing'));

  expect(fs.readFileSync(path.join(dir, 'shop.quiet.env.COMPOSER_SHOP_QUIET_PORT.json'))).toEqual(
    before,
  );

  const renamed = stageDir({ 'shop.quiet.json': appRow });
  renameRetiredComputeRows(renamed);
  const once = fs.readFileSync(path.join(renamed, 'shop.quiet.json'), 'utf8');
  renameRetiredComputeRows(renamed);
  expect(fs.readFileSync(path.join(renamed, 'shop.quiet.json'), 'utf8')).toBe(once);
});
