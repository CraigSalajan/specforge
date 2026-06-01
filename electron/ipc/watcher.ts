import { BrowserWindow, ipcMain } from 'electron';
import chokidar, { type FSWatcher } from 'chokidar';
import * as path from 'node:path';
import {
  scheduleReindexFile,
  scheduleRemoveFromIndex,
} from '../indexing/indexer';

const Channels = {
  FileChange: 'specforge:file-change',
  WatchVault: 'specforge:watch-vault',
  UnwatchVault: 'specforge:unwatch-vault',
} as const;

let watcher: FSWatcher | null = null;
let activeRoot: string | null = null;
let getWindows: () => BrowserWindow[] = () => BrowserWindow.getAllWindows();

export function getActiveVaultRoot(): string | null {
  return activeRoot;
}

function isMarkdown(p: string): boolean {
  return p.toLowerCase().endsWith('.md');
}

function broadcast(type: string, filePath: string): void {
  for (const win of getWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(Channels.FileChange, { type, path: filePath });
    }
  }
}

async function startWatching(vaultPath: string): Promise<void> {
  await stopWatching();
  const resolved = path.resolve(vaultPath);
  activeRoot = resolved;
  watcher = chokidar.watch(resolved, {
    ignored: (p) => /(?:^|[\\/])(?:node_modules|\.git|\.specforge|\.obsidian|\.vscode|dist|out)(?:[\\/]|$)/.test(p),
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    persistent: true,
  });
  watcher
    .on('add', (p) => {
      broadcast('add', p);
      if (isMarkdown(p) && activeRoot) scheduleReindexFile(activeRoot, p);
    })
    .on('change', (p) => {
      broadcast('change', p);
      if (isMarkdown(p) && activeRoot) scheduleReindexFile(activeRoot, p);
    })
    .on('unlink', (p) => {
      broadcast('unlink', p);
      if (isMarkdown(p) && activeRoot) scheduleRemoveFromIndex(activeRoot, p);
    })
    .on('addDir', (p) => broadcast('addDir', p))
    .on('unlinkDir', (p) => broadcast('unlinkDir', p))
    .on('error', (err) => console.error('[watcher]', err));
}

async function stopWatching(): Promise<void> {
  if (watcher) {
    await watcher.close();
    watcher = null;
  }
  activeRoot = null;
}

export function registerWatcherHandlers(windowsProvider: () => BrowserWindow[]): void {
  getWindows = windowsProvider;
  ipcMain.handle(Channels.WatchVault, async (_e, vaultPath: string): Promise<void> => {
    if (typeof vaultPath !== 'string' || vaultPath.length === 0) {
      throw new Error('Invalid vault path');
    }
    await startWatching(vaultPath);
  });
  ipcMain.handle(Channels.UnwatchVault, async (): Promise<void> => {
    await stopWatching();
  });
}

export function disposeWatcher(): void {
  if (watcher) {
    void watcher.close();
    watcher = null;
  }
  activeRoot = null;
}
