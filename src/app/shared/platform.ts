/**
 * Renderer platform detection. Electron exposes Chromium's `navigator`, so
 * `navigator.platform` is reliable here (no main-process IPC needed).
 */
export function isMacPlatform(): boolean {
  return /mac/i.test(navigator.platform ?? '');
}

/** Display label for the primary modifier key on this platform. */
export function primaryModifierLabel(): string {
  return isMacPlatform() ? 'Cmd' : 'Ctrl';
}
