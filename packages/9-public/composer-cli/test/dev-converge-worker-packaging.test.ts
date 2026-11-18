/** `prisma dev` starts its converge worker from the file beside the chunk that starts it, so each built package must ship the worker there. */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const packages = {
  '@prisma/composer-cli': path.resolve(import.meta.dir, '..', 'dist'),
  '@prisma/composer': path.resolve(import.meta.dir, '..', '..', 'composer', 'dist'),
};

describe('the dev converge worker in the built packages', () => {
  for (const [name, dist] of Object.entries(packages)) {
    test(`${name}: every chunk that starts the worker has dev-converge-worker.mjs beside it`, () => {
      const starters = fs
        .readdirSync(dist, { recursive: true, encoding: 'utf8' })
        .filter((file) => file.endsWith('.mjs'))
        .filter((file) =>
          fs.readFileSync(path.join(dist, file), 'utf8').includes('`./dev-converge-worker${'),
        );

      expect(starters.length).toBeGreaterThan(0);
      for (const starter of starters) {
        const worker = path.join(dist, path.dirname(starter), 'dev-converge-worker.mjs');
        expect({ starter, worker: fs.existsSync(worker) }).toEqual({ starter, worker: true });
      }
    });
  }
});
