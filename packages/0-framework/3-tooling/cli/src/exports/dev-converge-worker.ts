/** The worker thread `prisma dev` runs each converge in. Its built file is loaded by file URL from beside the dev executor; the public packages import this module so their builds hold their own worker file. */
import '../operations/dev-converge-worker.ts';
