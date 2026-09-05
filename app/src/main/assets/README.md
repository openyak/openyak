# OpenYak desktop branding

Original, unmodified assets from `origin/legacy/v1` commit
`8ecb61f80c351402182340be3790dd03fb016f2a`:

- `desktop-tauri/src-tauri/icons/macos-icon-1024.png`: Dock/window icon.
- `desktop-tauri/src-tauri/icons/tray-template@2x.png`: macOS template artwork.
- `desktop-tauri/src-tauri/icons/tray-template.png`: original 1x companion.

The menu bar image is normalized at runtime to 18 logical pixels high with
explicit 1x/2x representations; macOS handles light/dark template tinting.
Use `?asset` imports so electron-vite includes resources in both dev and build
outputs. Do not overwrite the installed Electron.app icon or its Info.plist.

v2 does not yet have an installer/packager. Runtime Dock branding is implemented
here; future macOS packaging must also configure the bundle's ICNS icon.
