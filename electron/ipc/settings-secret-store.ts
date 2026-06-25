/**
 * Production binding of {@link SecretSettingsStore} to the real SQLite-backed
 * settings repository.
 *
 * This is the single place the at-rest secret helpers (`secure-settings`'
 * migration and the `connection-secrets` factory) touch the DB: those modules
 * stay repo-free and take this store by injection, so they remain unit-testable
 * in the renderer's jsdom runner (which cannot load `node:sqlite`). Only
 * main-process wiring (`main.ts`, the connection-secret IPC handlers) imports
 * this module.
 */

import {
  getAllSettings,
  getSetting,
  setSetting,
} from '../db/repositories/settings.repo';
import type { SecretSettingsStore } from './secure-settings';

export const secretSettingsStore: SecretSettingsStore = {
  get: getSetting,
  set: setSetting,
  getAll: getAllSettings,
};
