import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync, copyFileSync, mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const common = {
  platform: 'node',
  target: 'node22',
  bundle: true,
  format: 'cjs',
  sourcemap: true,
  external: ['electron', 'chokidar', 'fsevents', 'electron-updater'],
  logLevel: 'info',
};

await build({
  ...common,
  entryPoints: [resolve(root, 'electron/main.ts')],
  outfile: resolve(root, 'dist/electron/main.js'),
});

await build({
  ...common,
  entryPoints: [resolve(root, 'electron/preload.ts')],
  outfile: resolve(root, 'dist/electron/preload.js'),
});

// Copy the master icon next to the bundle so the Electron runtime can load the
// window/dock icon in dev and when packaged. Degrades gracefully when absent.
const iconSrc = resolve(root, 'build/icon.png');
const electronOutDir = resolve(root, 'dist/electron');
if (existsSync(iconSrc)) {
  mkdirSync(electronOutDir, { recursive: true });
  copyFileSync(iconSrc, resolve(electronOutDir, 'icon.png'));
  console.log('[build-electron] Copied build/icon.png -> dist/electron/icon.png');
} else {
  console.warn(
    '[build-electron] build/icon.png not found; the window icon will use the Electron default. See build/README.md.',
  );
}

console.log('[build-electron] OK');
