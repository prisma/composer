import { defineConfig } from '@prisma/app-tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/bin.ts'],
  // The CLI declares its `.` export and `bin` by hand; don't auto-generate a
  // `./bin` export (the executable must not be importable).
  exports: false,
});
