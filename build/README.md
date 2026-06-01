# Application Icons

SpecForge uses a single master PNG to drive icons everywhere: the runtime
window/taskbar icon (Windows), the dock icon (macOS), and all packaged
installers (Windows / macOS / Linux).

## The master icon

Drop a square master PNG here:

```
build/icon.png
```

- Ideally **1024×1024** (minimum **512×512**).
- The app is dark-only, so design the artwork for a **near-black background
  (`#0b0d10`)**.

## Packaging (electron-builder)

At package time, electron-builder reads `build/` as its `buildResources`
directory and auto-generates the platform-specific icon formats from
`build/icon.png`:

- Windows `.ico`
- macOS `.icns`

You may optionally drop pre-rendered overrides next to the PNG to bypass the
auto-generation:

```
build/icon.ico    # overrides the generated Windows icon
build/icon.icns   # overrides the generated macOS icon
```

If `build/icon.png` is absent, electron-builder falls back to the default
Electron icon and only emits a warning, so packaging still succeeds.

## In-app / browser favicon

The renderer favicon is served separately from the packaging pipeline. Export a
256×256 (or multi-size) `.ico` and replace:

```
public/favicon.ico
```

It is referenced from `src/index.html` via `<link rel="icon" ...>`.

## Runtime window / dock icon

`scripts/build-electron.mjs` copies `build/icon.png` to
`dist/electron/icon.png` so the Electron runtime can load the window icon (and
the macOS dock icon) in both development and packaged builds. If the source PNG
is missing, the build prints a warning and the app uses the default Electron
icon.
