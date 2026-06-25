/**
 * esbuild bundle for the live Linear E2E harness (TER-25).
 *
 * Mirrors `bench/harness/build.mjs` but targets the E2E entrypoint and is
 * deliberately MINIMAL: unlike the bench harness this one consumes no Angular DI
 * (no `@Injectable()` classes, no `inject()`), so it needs none of bench's
 * decorator-metadata (`experimentalDecorators` / `emitDecoratorMetadata`)
 * machinery — plain esbuild transpilation suffices.
 *
 * `electron` is externalized: nothing in the push pipeline the harness assembles
 * (auth → client → adapter → engine → executor) should reach Electron or the DB,
 * and externalizing turns any accidental import into a loud runtime error rather
 * than a silently-bundled dependency. (`SyncLink` is imported type-only and is
 * erased before bundling, so the DB layer never enters the graph.) A successful
 * build is itself a proof that the import graph is electron-free and resolves.
 *
 * Emits a single self-contained ESM `.mjs` so the runner can `node` it directly.
 */

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..', '..');

await build({
  platform: 'node',
  target: 'node22',
  bundle: true,
  format: 'esm',
  sourcemap: true,
  logLevel: 'info',
  external: ['electron'],
  entryPoints: [resolve(root, 'e2e/linear/run.ts')],
  outfile: resolve(root, 'dist/e2e/linear-e2e.mjs'),
  // `import.meta.url` is fine in ESM; ensure any dynamic require resolves.
  banner: {
    js: "import { createRequire as __e2e_createRequire } from 'node:module'; const require = __e2e_createRequire(import.meta.url);",
  },
});

console.log('[build-e2e:linear] OK');
