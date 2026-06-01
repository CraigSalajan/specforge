import { BrowserWindow, dialog, ipcMain } from 'electron';

const SELECT_VAULT = 'specforge:select-vault';

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
}
