/**
 * esbuild bundle for the headless benchmark runner.
 *
 * Mirrors `scripts/build-electron.mjs` but targets the bench entrypoint and
 * emits ESM (`@angular/core` is ESM-first; bundling it in keeps the runner a
 * single self-contained `.mjs`). `electron` is externalized — nothing in the
 * bench graph should reach it, and externalizing makes any accidental import a
 * loud runtime error rather than a silently-bundled dependency.
 *
 * Angular's `@Injectable()` tool classes are consumed via DI but are NOT
 * AOT-compiled (esbuild doesn't run the Angular compiler), so we (a) emit
 * TypeScript's decorator metadata (`experimentalDecorators` +
 * `emitDecoratorMetadata`) and (b) `tools.ts` imports `reflect-metadata` and
 * `@angular/compiler` up top so Angular's JIT compiler can build each class
 * from that metadata at runtime.
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
  entryPoints: [resolve(root, 'bench/harness/runner.ts')],
  outfile: resolve(root, 'dist/bench/harness-runner.mjs'),
  // Angular's DI relies on decorator metadata when classes aren't compiled by
  // the Angular compiler; emit it so `@Injectable()`/`inject()` resolve.
  tsconfigRaw: {
    compilerOptions: {
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
      useDefineForClassFields: false,
    },
  },
  // `import.meta.url` is fine in ESM; ensure dynamic requires (if any) resolve.
  banner: {
    js: "import { createRequire as __bench_createRequire } from 'node:module'; const require = __bench_createRequire(import.meta.url);",
  },
});

console.log('[build-bench] OK');
