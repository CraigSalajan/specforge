/**
 * IPC seam for opening external URLs in the system browser.
 *
 * The renderer runs with `contextIsolation` and no window-open handler, so an
 * `<a target="_blank">` cannot open a link — the only safe path is to hand a
 * validated URL to Electron's `shell.openExternal` from the main process. This
 * module is that single, narrow channel.
 *
 * ## Why the URL is validated before it reaches the shell
 * `shell.openExternal` will happily launch *any* scheme the OS knows how to
 * handle (`file:`, `mailto:`, custom protocol handlers, …), so passing an
 * arbitrary renderer-supplied string is a real attack surface. We therefore
 * parse the input with `new URL(...)` and accept ONLY `http:`/`https:`; anything
 * else (an unparseable string, a `file:`/`javascript:`/custom scheme) is
 * rejected before the shell ever sees it. Deep links to created Linear issues
 * (TER-32) are always https, so this is not a real restriction for the feature.
 *
 * ## Thin registration shim — the pure handler lives alongside
 * {@link handleOpenExternal} is the electron-touching unit; it is kept separate
 * from the `ipcMain.handle` registration so the validation logic stays readable
 * and the registration mirrors the other IPC modules (see `./export`, `./sync`).
 */

import { ipcMain, shell } from 'electron';

const Channels = {
  OpenExternal: 'specforge:open-external',
} as const;

/**
 * Opens `url` in the user's default browser after validating it is an
 * `http:`/`https:` URL. Throws (rejecting the IPC call) for any other scheme or
 * an unparseable value, so a malformed/hostile string never reaches the shell.
 */
export async function handleOpenExternal(url: string): Promise<void> {
  if (typeof url !== 'string' || url.length === 0) {
    throw new Error('Invalid URL');
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Refusing to open malformed URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Refusing to open non-http(s) URL: ${parsed.protocol}`);
  }
  await shell.openExternal(parsed.toString());
}

/**
 * Registers the shell IPC handler. Stateless — no dispose function needed.
 * Mirrors the thin registration shims used by the other IPC modules.
 */
export function registerShellHandlers(): void {
  ipcMain.handle(Channels.OpenExternal, (_e, url: string) => handleOpenExternal(url));
}
