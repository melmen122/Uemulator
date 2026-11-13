# Uemulator

A desktop launcher (Node + Electron) that puts seven emulators behind one game library. You add ROM
folders, Uemulator detects each game's system, and Play starts the matching emulator as a child
process with live logs and a Stop button. Each emulator is an unmodified git submodule under
`cores/<id>`; Uemulator only finds and launches them.

Uemulator runs on macOS, Linux and Windows x64. See [Windows](#windows) for the Windows install.

## Supported systems

| System | Extensions | Core | Upstream | License |
|---|---|---|---|---|
| Nintendo 64 | `.z64` `.n64` `.v64` | Project64 (Windows native; macOS and Linux via Wine) | https://github.com/project64/project64 | GPL-2.0 |
| Nintendo Switch | `.nsp` `.xci` `.nca` `.nro` | Lichii (experimental, default); Ryujinx (Ryubing) as alternate | https://github.com/zortos293/Lichii, https://git.ryujinx.app/ryubing/ryujinx | GPL-3.0-or-later, MIT |
| Nintendo Switch 2 | Same files as Switch, classified by title ID | Lichii (very experimental) | https://github.com/zortos293/Lichii | GPL-3.0-or-later |
| Nintendo 3DS | `.3ds` `.cci` `.cxi` `.cia` `.3dsx` `.app` | Azahar | https://github.com/azahar-emu/azahar | GPL-2.0 |
| Game Boy Advance | `.gba` | mGBA | https://github.com/mgba-emu/mgba | MPL-2.0 |
| Game Boy | `.gb` | mGBA (default) or PyBoy | https://github.com/mgba-emu/mgba, https://github.com/Baekalfen/PyBoy | MPL-2.0, LGPL-3.0 |
| Game Boy Color | `.gbc` | mGBA (default) or PyBoy | https://github.com/mgba-emu/mgba, https://github.com/Baekalfen/PyBoy | MPL-2.0, LGPL-3.0 |
| PlayStation 3 | `.iso`, `EBOOT.BIN` (inside `USRDIR`) | RPCS3 | https://github.com/rpcs3/rpcs3 | GPL-2.0 |

Ryujinx moved off GitHub. Use the `git.ryujinx.app` URL above; the GitHub Ryubing org has no
emulator repository. The GB/GBC core is chosen in Settings. Switch and Switch 2 have no core setting.
Extension matching is case-insensitive.

### Nintendo Switch and Switch 2

- Switch 1 and Switch 2 games run in Lichii by default. Ryujinx is registered as an alternate core for
  Switch 1, but no control in the app selects it, so Play always starts Switch 1 games in Lichii.
- Switch and Switch 2 are separate systems in the library, each with its own tab and badge.
- Files are matched by extension (`.nsp`, `.xci`, `.nca`, `.nro`). A file is listed as Switch 2 only
  when its title ID starts with `04`. A title ID starting with `01` is Switch 1.
- The title ID comes from a best-effort guess:
  - `.nsp`: read from the ticket name (`<titleid><keygen>.tik`) in the file's PFS0 header, or from a
    bracketed 16-digit ID in the file name or in up to 3 parent folder names.
  - `.xci`, `.nca`, `.nro`: name and folder only. Their title IDs cannot be read without keys.
  - So an `.nsp` without a ticket, or any `.xci`, is detected as Switch 2 only when its file or folder
    name contains the bracketed title ID, for example `Game [0400…].xci`.
- Anything not recognised is treated as Switch 1 and launches in Lichii.
- The `04` rule comes from observed Switch 2 title IDs, not from a specification. A wrong guess can
  put a game under the wrong system or the wrong core.
- Play always uses the default core for the system (`switch`: Lichii). The launch IPC accepts a core
  override, but the app's UI does not offer one for Switch.
- Lichii is launched with `-g <game>`, plus `-f` when fullscreen is on.
- Both cores need keys and firmware that you obtain legally yourself. Uemulator does not supply them.

### PlayStation 3 library rules

- A PS3 game is a `.iso` file, or an `EBOOT.BIN` directly inside a `USRDIR` folder. Disc dumps look
  like `<Game>/PS3_GAME/USRDIR/EBOOT.BIN`. Installed or PSN titles look like `<TITLEID>/USRDIR/EBOOT.BIN`.
- `.pkg` installers are not supported.
- The scanner does not descend into subfolders of `USRDIR`. Other `EBOOT.BIN` files are ignored.
- The title comes from `TITLE` in the sibling `PARAM.SFO` when it can be read. Otherwise it uses the
  game folder name.
- RPCS3 needs PS3 firmware (`PS3UPDAT.PUP`) installed inside RPCS3 before games boot. Uemulator does
  not install firmware.

Upstream links come from `.gitmodules`. Each core keeps its own license; see `cores/<id>/` for the
full text.

## Quick start

```sh
git clone --recurse-submodules <repo-url> uemulator
cd uemulator
# or, for only the cores you want:
git submodule update --init --depth 1 cores/mgba cores/pyboy
npm install
npm start
```

Then add a ROM folder on the Library page. Games with a missing core show a warning on their card.
On Windows, follow the [Windows](#windows) section instead.

## Executable resolution

For each core, Uemulator uses the first match:

1. **Override path** set on the Cores page ("Set path…"). Stored in Settings.
2. **Built binary** in `bin/<id>/`, produced by `npm run build:cores`.
3. **System install** locations, for example `/Applications/mGBA.app`, `/opt/homebrew/bin`,
   `/usr/bin`. On Windows, see [Windows](#windows) for the folders searched.
4. **PATH** lookup by name, for example `mgba-qt`, `mgba`, `pyboy`, `azahar`, `Ryujinx`, `rpcs3`.
   On Windows only `.exe` hits count, so `.cmd` and `.bat` files on PATH are ignored.

On Windows, a chosen emulator path must end in `.exe`. Shortcuts, `.bat` and `.cmd` files are refused.

Project64 has no macOS or Linux build. On Windows it runs natively. On macOS and Linux, Uemulator runs the `Project64.exe` you set
as the override through Wine. The Wine binary is the first match from:

- `bin/wine/bin/wine`, installed by `npm run build:cores -- project64` on macOS
- `<userData>/runtime/wine/bin/wine`, the link that same step creates for the installed app
- `wine` or `wine64` on PATH (the usual choice on Linux)

Project64 is ready only when both a Wine binary and the `.exe` are found. Otherwise the Cores page
shows Not installed with the reason. On macOS, `Project64.exe` is never auto-detected. Set it with
Set path….

## Building cores

```sh
node scripts/build-cores.mjs --check          # toolchain check only, builds nothing
npm run build:cores -- mgba                   # one core
npm run build:cores                           # all cores (missing toolchains are skipped)
```

Options: `--jobs N` (parallel build jobs), `-h` (help). Missing toolchains print an install hint and
skip that core. Real build failures exit with code 1.

| Core | Output | Requirements (checked by the script) |
|---|---|---|
| `mgba` | `bin/mgba/` | `git`, `cmake`. Qt and SDL2 libraries are needed for the frontends. Without Qt, the Qt frontend is skipped. |
| `pyboy` | `bin/pyboy/venv/` | Python 3.9+ (`python3`, or `python` / `py` on Windows), a C compiler for the Cython extension. |
| `azahar` | `bin/azahar/` | `git`, `cmake`. Qt 6, SDL2 and a C++20 compiler are needed (the script only checks `cmake`). |
| `ryujinx` | `bin/ryujinx/` | .NET SDK 10 or newer. The version comes from `cores/ryujinx/global.json`. |
| `project64` | `bin/project64/` (Windows), `bin/wine/` (macOS) | Windows: `git`, MSBuild (Visual Studio 2019 or newer). macOS: Rosetta 2 on Apple Silicon, `tar`, `curl`. Linux: not built here. Install `wine` from your package manager. |
| `lichii` | `bin/lichii/` | `git`, `cmake`, `ninja`, Qt 6 (Widgets, Charts), a C/C++ compiler. macOS and Linux also need `glslangValidator`. Windows needs Visual Studio 2022 (C++ workload) and the Vulkan SDK (`VULKAN_SDK`). The script skips Lichii when a tool is missing. |
| `rpcs3` | `bin/rpcs3/` | `git`, `cmake` 3.28+, Qt 6.7+ (Widgets, Multimedia, Svg), SDL3, Vulkan, LLVM (system LLVM on macOS/Linux; built from the submodule on Windows), Clang 19+ or GCC 13+. Windows needs Visual Studio 2022 and the Vulkan SDK (`VULKAN_SDK`). `ninja` is needed on macOS and Linux. Upstream officially supports Windows and Linux. The macOS path is best-effort and has not been run here. |

The script prints the install command for each missing tool (for example `brew install cmake qt
sdl2` on macOS). Build directories live in `bin/.build/`, and nothing under `cores/` is edited.

### Project64 on macOS

Project64 has no macOS build, so Uemulator runs the Windows `Project64.exe` through Wine.

1. Install Rosetta 2 (Apple Silicon only): `softwareupdate --install-rosetta --agree-to-license`
2. Install the Wine runtime: `npm run build:cores -- project64`. It downloads Wine 11.18 (Gcenx
   `macOS_Wine_builds`, x86_64, about 190 MB), checks its SHA-256 before extracting, and puts it in
   `bin/wine/`. It also links the runtime at `~/Library/Application Support/uemulator/runtime/wine`
   so the installed app can find it. Re-running the command skips the download if Wine already works.
3. Download `Project64.exe` from https://www.pj64-emu.com.
4. In Uemulator, open Cores → Project64 → Set path… and choose `Project64.exe`. The status becomes Ready.

The first game launch takes about 30 seconds while Wine creates its prefix. The Wine pin (version,
URL and SHA-256) is the same pinned Wine build that neutron uses (OmniTroid/neutron, BSD-3-Clause,
https://github.com/OmniTroid/neutron).
Uemulator downloads the Gcenx build itself. It does not use neutron's Steam bridge or DXMT.

## Windows

Uemulator runs on Windows x64. Project64 runs natively there, so no Wine is needed. The unit tests
(332) pass on Windows 11. The installer and the app have not been run end to end on Windows yet, and
the bundled emulators (see [Bundled emulators](#bundled-emulators)) have not been play-tested there.

### Windows quick start

From source (dev mode, needs network access once):

```bat
git clone --recurse-submodules <repo-url> uemulator
cd uemulator
npm install
node scripts/bundle-win.mjs --out bin
npm start
```

`--out bin` fills `bin\` with the four bundled emulators, which is where `npm start` looks for them.
Archives are cached in `bundle-win\cache\`. For an installer instead, run `npm run dist:win`. The
output goes to `dist\`.

1. Add your ROM folder on the Library page (see [First run](#first-run)).
2. Switch keys: put `prod.keys` and `title.keys`, dumped from your own console, in `%APPDATA%\lichii\keys\`.
   If a `user` folder exists next to `lichii.exe`, Lichii checks `user\keys\` first.
3. Install Switch firmware inside Lichii with Tools > Install Firmware.
4. Ryujinx, Project64 and PyBoy are not bundled on Windows. Install them, then choose the `.exe` with
   **Set path…** on the Cores view.

### Ocarina of Time on an NVIDIA GPU

The Ocarina of Time remake is a Switch 2 `.nup` (title ID `0400486024DEC000`). In Lichii's Graphics
settings:

- Enable **Use NVIDIA DLSS** (`nvidia_dlss`). Click its download button to fetch the NVIDIA
  DLSS/Streamline runtime. You must accept NVIDIA's license.
- Quality: Automatic or Quality. Preset: K (Quality/Balanced) or M (Performance).
- Keep `oot_anti_aliasing` at Game. `NoSharpening` is a workaround for Mac GPUs.
- Leave the resolution scale at its default.

### Install

Use one of the two files built by `npm run dist:win` (see [Building the installer](#building-the-installer)):

- **Installer:** `dist/Uemulator-Setup-0.1.0-x64.exe`. It is a per-user install. You choose the install
  folder, and it adds desktop and Start menu shortcuts.
- **Portable:** `dist/Uemulator-0.1.0-win-x64.zip`. Unzip it and run `Uemulator.exe`.

Both files are unsigned, so SmartScreen may warn. Click **More info**, then **Run anyway**.

To run from source, use PowerShell or cmd:

```bat
git clone --recurse-submodules <repo-url> uemulator
cd uemulator
npm install
npm start
```

### First run

Settings and the library are saved in `%APPDATA%\uemulator\uemulator.json`. Add a ROM folder on the
Library page. Windows folder rules:

- A drive root (`C:\`) and your home folder cannot be added. Choose a folder inside them.
- UNC shares such as `\\nas\roms` work.
- `$RECYCLE.BIN` and `System Volume Information` are skipped.

### Setting emulator paths

Auto-detect looks in these places, in this order:

1. The bundled emulators. In the installed app this is `<install folder>\resources\emulators\<id>\`.
   With `npm start` it is `bin\<id>\` in the repo, filled by `node scripts/bundle-win.mjs --out bin` or
   built by `npm run build:cores`.
2. `Program Files`, `Program Files (x86)` and `ProgramW6432`.
3. `%LOCALAPPDATA%\Programs`, then `%LOCALAPPDATA%`.
4. Your home folder and the drive root, one folder deep, for example `C:\mGBA\mGBA.exe`.
5. PATH (`.exe` files only).

If auto-detect misses a core, open **Cores**, choose **Set path…**, and pick the `.exe`. Only `.exe`
files are accepted.

### Bundled emulators

`npm run dist:win` ships official Windows x64 builds of four cores inside the app, so they work
without a separate install:

| Core | Version | Systems | Bundled executable |
|---|---|---|---|
| Lichii (experimental) | build-160 (non-PGO) | Switch, Switch 2 | `lichii\lichii.exe` |
| mGBA | 0.10.5 | GBA, GB, GBC | `mgba\mGBA.exe` |
| Azahar | 2126.2 | 3DS | `azahar\azahar.exe` |
| RPCS3 | 0.0.43-20574 | PS3 | `rpcs3\rpcs3.exe` |

- Project64, Ryujinx and PyBoy are not bundled. Install them as described below.
- Keys, firmware and games are never bundled. RPCS3 still needs PS3 firmware installed inside RPCS3.
- The bundled set has not been run on Windows.

To rebuild the bundle, run this on a machine with network access:

```sh
npm run bundle:win                 # download, verify and extract the four builds
npm run bundle:win -- --force      # re-extract even when the bundle is up to date
node scripts/bundle-win.mjs --out bin   # dev mode: fill <repo>\bin for npm start
```

The script (`scripts/bundle-win.mjs`) downloads each archive into `bundle-win/cache/`, checks its
SHA-256 against the pinned value, rejects archives with unsafe entry paths, and extracts it with
`bsdtar` into `bundle-win/emulators/<id>/` (or the `--out` folder). `bsdtar` ships with macOS. On
Windows 10+ the script uses `%SystemRoot%\System32\tar.exe`, which is libarchive's bsdtar, and accepts
it only if `--version` reports bsdtar or libarchive. On Linux, install `libarchive-tools`. The versions and hashes are pinned in the `MANIFEST` in that script. The
mGBA hash comes from the first download, because upstream publishes no checksum for that file. `bundle-win/`
is gitignored. `npm run dist:win` runs `bundle:win` first, and the electron-builder
`extraResources` setting copies the result into the app's `resources\emulators\`.

A bundled copy is checked before any system install, so a copy of one of these four in
`Program Files` is used only when the bundled copy is missing.

Official Windows downloads (for Project64, Ryujinx and PyBoy, or for a different version of the four above):

| Core | Systems | Download | File to choose |
|---|---|---|---|
| mGBA | GBA, GB, GBC | https://mgba.io | `mGBA.exe` |
| Azahar | 3DS | https://azahar-emu.org | `azahar.exe` |
| Ryujinx (Ryubing) | Switch | https://ryujinx.app | `Ryujinx.exe` |
| Lichii (experimental) | Switch, Switch 2 | https://github.com/zortos293/Lichii/releases | `lichii.exe` (folder with its Qt DLLs; choose the exe inside) |
| RPCS3 | PS3 | https://rpcs3.net | `rpcs3.exe` (portable build, extract anywhere) |
| Project64 3.x | N64 | https://www.pj64-emu.com | `Project64.exe`. Install to `C:\Program Files (x86)\Project64 3.0`, or use the zip. |
| PyBoy | GB, GBC (optional) | `npm run build:cores -- pyboy` | `bin\pyboy\venv\Scripts\python.exe`, or `pyboy.exe` on PATH |

RPCS3 needs PS3 firmware installed inside RPCS3 before games boot. Uemulator does not install it.

### Building cores on Windows (optional)

Building from source is heavy. Most people should use the official builds above. To build, open a
Developer PowerShell for VS 2022 and run:

```powershell
node scripts/build-cores.mjs --check
npm run build:cores -- pyboy
```

The script checks for Visual Studio Build Tools (MSBuild), CMake, Qt 6 (set `Qt6_ROOT`), the Vulkan
SDK (sets `VULKAN_SDK`, for RPCS3) and the .NET SDK (for Ryujinx). The Building cores table lists each
core's requirements.

### Building the installer

```sh
npm run dist:win
```

This runs `npm run bundle:win` first (see [Bundled emulators](#bundled-emulators)), then builds the NSIS
installer and the zip for x64 into `dist/`. The settings are in the `build` section of `package.json`.
The Windows targets build from macOS or Linux without Wine. The output has not been installed on
Windows yet.

### Windows limitations

- Only the unit tests have been run on Windows (Windows 11). The installer and the app have not been run
  end to end there.
- Unsigned. SmartScreen may block the first run.
- Stop asks the emulator to close. If it has not exited after about 5 seconds, Uemulator force-ends its
  whole process tree, so unsaved progress can be lost.
- The app menu is hidden on Windows.
- The installed app auto-detects only the bundled set in `resources\emulators\`. Core builds in the repo's
  `bin\` are used only by `npm start`.
- Project64 does not open ROMs with non-ASCII file names. This also applies on Windows. See Known limitations.

## Where data is stored

- **Settings and library:** one JSON file, `uemulator.json`, in Electron's `userData` directory for
  the app (`app.getPath('userData')`). The app name comes from `package.json` (`uemulator`). On macOS
  this is `~/Library/Application Support/uemulator/`. On Windows it is `%APPDATA%\uemulator\`.
- Writes go to a `.tmp` file that is then renamed over the old one. If the file is not valid JSON,
  it is renamed to `uemulator.json.corrupt` and defaults are used.
- Built cores live in `bin/` (gitignored). The Windows bundle is staged in `bundle-win/` (gitignored).
- Wine prefixes live in `<userData>/wine/<coreId>/`. Project64 is the only Wine-run core, so this is
  `~/Library/Application Support/uemulator/wine/project64/` on macOS. Uemulator creates it with mode 0700.

### Moving to another machine

- Settings, the library and the Wine prefix are per machine. They are not carried over automatically.
- ROMs and game data are not part of Uemulator. Copy your ROM folders yourself.
- For PS3, install the firmware in RPCS3 again on the new machine.
- Windows RPCS3 is the best-supported RPCS3 platform.

## Keyboard shortcuts

| Where | Key | Action |
|---|---|---|
| Anywhere (not in a text field) | `/` | Open Library and focus search |
| Search box | `Esc` | Clear the query; if empty, leave the field |
| Search box | `↓` or `Enter` | Move focus to the first game card |
| Game card | Arrow keys, `Home`, `End` | Move selection |
| Game card | `↑` on the top row | Move focus back to search |
| Game card | `Enter` | Launch the game |
| Game card | `F` | Toggle favorite |
| Segmented controls (Settings: theme, GB core) | Arrow keys | Select the next or previous option |

Cards ignore keys when `Ctrl`, `Alt` or `Meta` is held. There is no keyboard shortcut for Stop; use
the button on the Running panel.

## Development

```sh
npm test          # node --test "tests/**/*.test.js" (332 unit tests)
npm start         # run the app
npm run dist      # electron-builder packaging
npm run bundle:win  # fetch and verify the bundled Windows emulators (see Windows)
npm run dist:win    # Windows x64 NSIS installer and zip (runs bundle:win first)
```

Add `?mock` to the renderer URL to preview the UI with sample data (`?mock=empty` for the empty state).

Layout:

```
src/main/        main.js (window, hardening), ipc.js (handlers + validation), store.js,
                 library.js (folder scan), systems.js (system table), processes.js (child processes)
src/main/cores/  one adapter per core + index.js (registry, executable resolution)
src/preload/     preload.js, the only bridge to the page (window.uemu)
src/renderer/    index.html, styles.css, app.js, state.js, ui.js, views/*.js, mock.js
scripts/         build-cores.mjs, bundle-win.mjs
tests/           node:test unit tests for the main-process modules
docs/design.md   UI design notes
cores/           upstream submodules (not edited)
bin/             built cores (generated, gitignored)
bundle-win/      Windows emulator bundle (generated, gitignored)
plan.md          architecture and contracts
```

## Security

- The renderer runs with `contextIsolation`, `sandbox`, and without `nodeIntegration`. It only sees
  the fixed `window.uemu` API from `preload.js`.
- A strict CSP applies (`default-src 'self'`, `connect-src 'none'`), set both in the HTML and as a
  response header.
- Navigation, `window.open` and `<webview>` are blocked. Browser permission requests are denied.
- IPC handlers validate every argument. Calls from non-`file://` frames are rejected.
- `launch` takes only a game id that is in the library. The renderer cannot pass a path or command.
  Executables come only from the resolution order above.
- Emulators are started with `spawn(cmd, args, { shell: false })`. Stop sends SIGTERM and falls back
  to SIGKILL after 5 seconds. On Windows, Stop uses `taskkill` instead: a close request, then a forced
  end of the process tree after 5 seconds. Running games are stopped when the app quits.
- Only the Wine launch sets environment variables, and only `WINEPREFIX`, `WINEDEBUG` and
  `WINEDLLOVERRIDES` (an allowlist in `processes.js`). The child inherits the app's environment
  without `WINELOADER`, `DYLD_*` or `LD_*`. The renderer cannot set any of these.

## Known limitations

- No embedded play. Games run in the emulator's own window, outside Uemulator.
- Cores are launched as external windows. Uemulator tracks the process and its logs only.
- No prebuilt core installer. Cores must be built locally or installed by hand.
- Build paths for cmake, .NET and RPCS3 are untested on the development machine. None of the seven
  emulators is installed there, so real-emulator launches are untested.
- Windows x64: the unit tests pass on Windows 11. The installer, auto-detect, Stop, Project64 and the
  bundled emulators have not been run end to end there. See [Windows](#windows).
- Project64 on macOS runs under Wine and Rosetta 2. Only the Wine runtime has been checked here
  (`wine --version` and a `cmd /c ver` smoke test). Project64 itself has not been run under Wine in
  this repo.
- The first Project64 launch is slow (about 30 seconds) while Wine creates its prefix.
- The ROM path is passed to Wine as a raw Unix path. Paths that Wine cannot map are untested.
- Project64 does not open ROMs whose file names contain non-ASCII characters (e.g. "Pokémon"). It
  reads its command-line arguments as ANSI and then decodes them as UTF-8 (`cores/project64`
  `Source/Project64/main.cpp:12` and `Source/Common/File.cpp:126`). A `?` in a file name is also
  treated as a 7z sub-file separator (`Source/Project64-core/N64System/N64Rom.cpp:573`). This applies
  to Project64 on Windows too. Workaround: rename the ROM with ASCII-only characters.
- The packaged app finds the Wine runtime only through the app data link. On Windows it finds the
  bundled emulators in `resources\emulators\`. Other cores' repo-built binaries in `bin/<id>/` are found
  only by `npm start` and by system install locations.
- Licenses: each core keeps its own license (see table above). Uemulator is a launcher that starts
  those programs as separate processes. Check each core's license before you redistribute builds.
