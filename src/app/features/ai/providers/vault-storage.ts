/**
 * Typed re-export of the read/write/create/rename/delete surface the AI
 * harness needs. Keeps the AI feature from reaching across feature
 * boundaries directly into VaultService — provider code imports this
 * narrow interface instead.
 *
 * The runtime implementation is the existing `VaultService` / `IpcService`.
 * The AI feature gets the implementation via DI through this token.
 */

import { InjectionToken, inject } from '@angular/core';
import { IpcService } from '../../../core/ipc.service';

export interface VaultStorage {
  readFile(absPath: string): Promise<string>;
  writeFile(absPath: string, content: string): Promise<void>;
  createFile(absPath: string): Promise<void>;
  renameFile(oldAbs: string, newAbs: string): Promise<void>;
  deleteFile(absPath: string): Promise<void>;
}

export const VAULT_STORAGE = new InjectionToken<VaultStorage>('VaultStorage', {
  providedIn: 'root',
  factory: (): VaultStorage => {
    const ipc = inject(IpcService);
    return {
      readFile: (p) => ipc.readFile(p),
      writeFile: (p, c) => ipc.writeFile(p, c),
      createFile: (p) => ipc.createFile(p),
      renameFile: (a, b) => ipc.renameFile(a, b),
      deleteFile: (p) => ipc.deleteFile(p),
    };
  },
});
