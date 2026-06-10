import { BrowserWindow, dialog, ipcMain } from 'electron';

const SELECT_VAULT = 'specforge:select-vault';
const SELECT_DIRECTORY = 'specforge:select-directory';

export function registerDialogHandlers(): void {
  ipcMain.handle(SELECT_VAULT, async (): Promise<string | null> => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const result = await dialog.showOpenDialog(win, {
      title: 'Select Vault Folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // Generic folder picker (e.g. for skill directories). Mirrors select-vault
  // but carries no vault semantics and no create-folder affordance.
  ipcMain.handle(SELECT_DIRECTORY, async (): Promise<string | null> => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const result = await dialog.showOpenDialog(win, {
      title: 'Select Folder',
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });
}
