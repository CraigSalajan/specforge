import { BrowserWindow, Menu, app, ipcMain, nativeImage } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import { autoUpdater } from 'electron-updater';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { registerDialogHandlers } from './ipc/dialog';
import { registerVaultHandlers } from './ipc/vault';
import { registerWatcherHandlers, disposeWatcher } from './ipc/watcher';
import { registerSettingsHandlers } from './ipc/settings';
import { registerConnectionSecretHandlers } from './ipc/connection-secrets';
import { registerSyncHandlers } from './ipc/sync';
import { createProductionSyncContext } from './ipc/sync-deps';
import { migratePlaintextSecrets } from './ipc/secure-settings';
import { secretSettingsStore } from './ipc/settings-secret-store';
import { registerIndexHandlers } from './ipc/index';
import { registerLinkHandlers } from './ipc/links';
import { registerDocPropertiesHandlers } from './ipc/doc-properties';
import { registerChatHandlers } from './ipc/chats';
import { registerEmbeddingHandlers } from './ipc/embeddings';
import { registerAiHistoryHandlers } from './ipc/ai-history';
import { registerAiHandlers, disposeAiHandlers } from './ipc/ai';
import { registerSkillsHandlers } from './ipc/skills';
import { registerExportHandlers } from './ipc/export';
import { registerShellHandlers } from './ipc/shell';
import { getDb, closeDb } from './db/index';

const isDev = process.env['SPECFORGE_DEV'] === '1';

// Replaced at build time by esbuild `define`. True only in production builds published to
// GitHub via `npm run release` (CI). Local dev/build/package leave it false so DevTools remain
// available for debugging.
declare const __SPECFORGE_PRODUCTION_RELEASE__: boolean;
const isProductionRelease = __SPECFORGE_PRODUCTION_RELEASE__;

function resolveIndexFile(): string {
  // Built layout: dist/electron/main.js + dist/angular/browser/index.html
  return path.resolve(__dirname, '..', 'angular', 'browser', 'index.html');
}

// Resolves the runtime window/dock icon. Returns the first candidate that
// exists, or undefined so callers can fall back to the default Electron icon.
function resolveIconPath(): string | undefined {
  const candidates = [
    path.join(__dirname, 'icon.png'), // copied next to the bundle by the build script (dev + packaged/asar)
    path.resolve(__dirname, '..', '..', 'build', 'icon.png'), // project build/ dir fallback
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

// Replaces Electron's DEFAULT application menu, whose File > Close Window
// accelerator (CmdOrCtrl+W) closes the window before the renderer ever sees
// the keydown — the app binds Ctrl/Cmd+W to "close editor tab". The template
// keeps the default menu's useful accelerator roles — clipboard editing,
// reload / force-reload / DevTools / zoom under View — and omits only the
// File menu (the sole owner of the close-window accelerator). On Windows and
// Linux the menu bar stays hidden (autoHideMenuBar), so this is effectively
// just an accelerator table; on macOS the standard app/Edit/Window menus are
// preserved so system shortcuts (quit, hide, clipboard) keep working.
function setupApplicationMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' } satisfies MenuItemConstructorOptions] : []),
    { role: 'editMenu' },
    { role: 'viewMenu' },
    ...(isMac ? [{ role: 'windowMenu' } satisfies MenuItemConstructorOptions] : []),
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Wires electron-updater to the GitHub Releases feed. No-ops in dev (there is no
// app-update.yml outside a packaged build). Logs lifecycle events to the console.
function setupAutoUpdates(): void {
  if (isDev) return;
  autoUpdater.on('checking-for-update', () => console.log('[updater] Checking for update…'));
  autoUpdater.on('update-available', (info) => console.log('[updater] Update available:', info.version));
  autoUpdater.on('update-not-available', () => console.log('[updater] Up to date'));
  autoUpdater.on('download-progress', (p) => console.log(`[updater] Downloading ${Math.round(p.percent)}%`));
  autoUpdater.on('update-downloaded', (info) => console.log('[updater] Update downloaded:', info.version));
  autoUpdater.on('error', (err) => console.error('[updater] Error:', err));
  void autoUpdater.checkForUpdatesAndNotify();
}

async function createWindow(): Promise<void> {
  const iconPath = resolveIconPath();

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0b0d10',
    autoHideMenuBar: true,
    show: false,
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      // Hard-disable the DevTools backend in published production builds. This stops auto-open
      // and makes F12 / Ctrl+Shift+I / the default menu's "Toggle Developer Tools" no-ops.
      devTools: !isProductionRelease,
    },
  });

  win.once('ready-to-show', () => win.show());

  if (isDev) {
    await win.loadURL('http://localhost:4200');
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    await win.loadFile(resolveIndexFile());
  }

  // Forward watcher events to this window
  ipcMain.removeAllListeners('__internal_file_change_broadcast');
}

app.whenReady().then(async () => {
  // Improves Windows taskbar icon grouping/identity.
  app.setAppUserModelId('com.specforge.app');

  setupApplicationMenu();

  // On macOS, set the dock icon explicitly when the master icon is available.
  if (process.platform === 'darwin' && app.dock) {
    const iconPath = resolveIconPath();
    if (iconPath) app.dock.setIcon(nativeImage.createFromPath(iconPath));
  }

  // Initialize DB eagerly so PRAGMAs/migrations run before the first IPC call.
  try {
    getDb();
  } catch (err) {
    console.error('[main] Failed to initialize SQLite database:', err);
  }

  // One-time at-rest encryption of secret settings (e.g. ai.apiKey). Runs here
  // because safeStorage requires the app `ready` event and the DB must be open.
  try {
    migratePlaintextSecrets(secretSettingsStore);
  } catch (err) {
    console.error('[main] Failed to migrate secret settings to encrypted storage:', err);
  }

  registerDialogHandlers();
  registerVaultHandlers();
  registerWatcherHandlers(() => BrowserWindow.getAllWindows());
  registerSettingsHandlers();
  registerConnectionSecretHandlers();
  registerSyncHandlers(createProductionSyncContext());
  registerIndexHandlers();
  registerLinkHandlers();
  registerDocPropertiesHandlers();
  registerChatHandlers();
  registerEmbeddingHandlers();
  registerAiHistoryHandlers();
  registerAiHandlers();
  registerSkillsHandlers();
  registerExportHandlers();
  registerShellHandlers();

  await createWindow();

  setupAutoUpdates();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('window-all-closed', () => {
  disposeAiHandlers();
  disposeWatcher();
  closeDb();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  disposeAiHandlers();
  disposeWatcher();
  closeDb();
});
