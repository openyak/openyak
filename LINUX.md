# Linux Support for OpenYak Desktop

OpenYak desktop app now includes full Linux support with native packages for major distributions.

## Supported Distributions

OpenYak has been tested and is officially supported on:

- **Ubuntu** 22.04 LTS and later
- **Fedora** 38 and later
- **Debian** 12 (Bookworm) and later
- **Linux Mint** 21 and later
- **Pop!_OS** 22.04 and later

Other distributions may work but are not officially tested.

## Installation

### Debian/Ubuntu-based distributions (.deb)

Download the `.deb` package from the [releases page](https://github.com/openyak/desktop/releases) and install:

```bash
sudo dpkg -i openyak_*.deb
sudo apt-get install -f  # Install dependencies if needed
```

Or double-click the `.deb` file in your file manager to install via the Software Center.

### Fedora/RHEL-based distributions (.rpm)

Download the `.rpm` package from the [releases page](https://github.com/openyak/desktop/releases) and install:

```bash
sudo dnf install openyak-*.rpm
```

Or:

```bash
sudo rpm -i openyak-*.rpm
```

### Universal AppImage

The AppImage format works on any Linux distribution without installation:

1. Download the `.AppImage` file from the [releases page](https://github.com/openyak/desktop/releases)
2. Make it executable:
   ```bash
   chmod +x OpenYak_*.AppImage
   ```
3. Run it:
   ```bash
   ./OpenYak_*.AppImage
   ```

You can also integrate the AppImage with your desktop environment using [AppImageLauncher](https://github.com/TheAssassin/AppImageLauncher).

## System Requirements

### Required System Packages (End Users)

The packaged versions (.deb, .rpm, .AppImage) bundle most dependencies, but you need these system libraries:

**Debian/Ubuntu:**
```bash
sudo apt-get install libwebkit2gtk-4.1-0 libayatana-appindicator3-1 zenity
```

**Fedora:**
```bash
sudo dnf install webkit2gtk4.1 libayatana-appindicator-gtk3 zenity
```

**Note:** `zenity` is required for native file dialogs. If not installed, file selection features may not work properly.

## Running from Source

To build and run OpenYak from source on Linux:

### 1. Install Build Dependencies

**Ubuntu 22.04:**
```bash
sudo apt-get update
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  patchelf \
  build-essential \
  curl \
  wget \
  libssl-dev \
  libgtk-3-dev \
  libsoup-3.0-dev \
  zenity
```

**Fedora 38+:**
```bash
sudo dnf install -y \
  webkit2gtk4.1-devel \
  libayatana-appindicator-gtk3-devel \
  librsvg2-devel \
  patchelf \
  gcc \
  gcc-c++ \
  make \
  curl \
  wget \
  openssl-devel \
  gtk3-devel \
  libsoup3-devel \
  zenity
```

### 2. Install Development Tools

**Node.js 20:**
```bash
# Using nvm (recommended)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
nvm install 20
nvm use 20

# Or via package manager
sudo apt-get install nodejs npm  # Ubuntu
sudo dnf install nodejs npm      # Fedora
```

**Python 3.11:**
```bash
sudo apt-get install python3.11 python3.11-venv python3-pip  # Ubuntu
sudo dnf install python3.11 python3-pip                       # Fedora
```

**Rust:**
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source $HOME/.cargo/env
```

### 3. Build and Run

```bash
# Clone the repository
git clone https://github.com/openyak/desktop.git
cd desktop

# Install frontend dependencies
cd frontend
npm ci --legacy-peer-deps

# Build frontend
DESKTOP_BUILD=true NEXT_PUBLIC_DESKTOP_BUILD=true npm run build
cd ..

# Build backend
cd backend
python3.11 -m venv venv
source venv/bin/activate
pip install -r requirements.txt pyinstaller
pyinstaller openyak.spec --noconfirm
python3 scripts/download_node.py
deactivate
cd ..

# Build desktop app
cd desktop-tauri
cargo tauri build --config build.linux-x64.json
```

The built packages will be in:
- `.deb`: `desktop-tauri/src-tauri/target/release/bundle/deb/`
- `.AppImage`: `desktop-tauri/src-tauri/target/release/bundle/appimage/`
- `.rpm`: `desktop-tauri/src-tauri/target/release/bundle/rpm/`

## Features

All features available on Windows and macOS are supported on Linux:

- ✅ System tray integration (using Ayatana indicators)
- ✅ Native file dialogs (via zenity)
- ✅ Auto-updates
- ✅ Deep linking (openyak:// protocol)
- ✅ Window state persistence
- ✅ Keyboard shortcuts
- ✅ Python backend with embedded Node.js runtime

## Known Issues and Limitations

### System Tray
- The system tray uses Ayatana AppIndicator library, which is the modern standard for Ubuntu/GNOME
- Some desktop environments (e.g., vanilla GNOME) may require the "AppIndicator Support" extension
- On KDE Plasma, the tray icon should work out of the box

### File Dialogs
- File selection dialogs use `zenity`, which must be installed system-wide
- If zenity is not available, file operations may not work correctly

### Wayland vs X11
- OpenYak supports both Wayland and X11
- Some features (like window positioning) may behave differently under Wayland due to compositor restrictions

### Permissions
- The app requires access to the filesystem for reading/writing user data
- Network access is required for AI model API calls

## Troubleshooting

### App doesn't start
1. Check system dependencies are installed (see "Required System Packages" above)
2. Run from terminal to see error messages:
   ```bash
   openyak  # If installed via .deb/.rpm
   ./OpenYak_*.AppImage  # If using AppImage
   ```

### System tray icon not showing
- Install AppIndicator support for your desktop environment:
  ```bash
  # GNOME
  sudo apt-get install gnome-shell-extension-appindicator

  # Enable the extension via GNOME Extensions app
  ```

### File dialogs not working
- Install zenity:
  ```bash
  sudo apt-get install zenity  # Debian/Ubuntu
  sudo dnf install zenity      # Fedora
  ```

### "Cannot find libwebkit2gtk" error
- Install WebKitGTK 4.1:
  ```bash
  sudo apt-get install libwebkit2gtk-4.1-0  # Ubuntu 22.04+
  ```

### AppImage won't run
- Make sure it's executable: `chmod +x OpenYak_*.AppImage`
- Try running with `--appimage-extract-and-run` flag if FUSE is not available:
  ```bash
  ./OpenYak_*.AppImage --appimage-extract-and-run
  ```

## Uninstallation

**Debian/Ubuntu:**
```bash
sudo apt-get remove openyak
```

**Fedora:**
```bash
sudo dnf remove openyak
```

**AppImage:**
Simply delete the `.AppImage` file and any desktop integration files created by AppImageLauncher.

## Data Location

User data is stored in:
```
~/.local/share/openyak-desktop/
```

Configuration files:
```
~/.config/openyak-desktop/
```

## Support

If you encounter issues on Linux:

1. Check this document for known issues and solutions
2. Search existing [GitHub Issues](https://github.com/openyak/desktop/issues)
3. Create a new issue with:
   - Your Linux distribution and version
   - Desktop environment (GNOME, KDE, etc.)
   - Error messages from terminal output
   - Steps to reproduce

## Contributing

We welcome contributions to improve Linux support! Areas where help is appreciated:

- Testing on additional distributions
- Flatpak/Snap packaging
- Desktop environment-specific improvements
- Documentation improvements

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.
