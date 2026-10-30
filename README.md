# Uemulator

A desktop launcher (Node + Electron) that puts six emulators behind one game library. You add ROM
folders, Uemulator detects each game's system, and Play starts the matching emulator as a child
process with live logs and a Stop button. Each emulator is an unmodified git submodule under
`cores/<id>`; Uemulator only finds and launches them.

## Supported systems

| System | Extensions | Core | Upstream | License |
|---|---|---|---|---|
| Nintendo 64 | `.z64` `.n64` `.v64` | Project64 | https://github.com/project64/project64 | GPL-2.0 |
| Nintendo Switch | `.nsp` `.xci` `.nca` `.nro` | Ryujinx (Ryubing) | https://git.ryujinx.app/ryubing/ryujinx | MIT |
| Nintendo 3DS | `.3ds` `.cci` `.cxi` `.cia` `.3dsx` `.app` | Azahar | https://github.com/azahar-emu/azahar | GPL-2.0 |
| Game Boy Advance | `.gba` | mGBA | https://github.com/mgba-emu/mgba | MPL-2.0 |
| Game Boy | `.gb` | mGBA (default) or PyBoy | https://github.com/mgba-emu/mgba, https://github.com/Baekalfen/PyBoy | MPL-2.0, LGPL-3.0 |
| Game Boy Color | `.gbc` | mGBA (default) or PyBoy | https://github.com/mgba-emu/mgba, https://github.com/Baekalfen/PyBoy | MPL-2.0, LGPL-3.0 |
| PlayStation 3 | `.iso`, `EBOOT.BIN` (inside `USRDIR`) | RPCS3 | https://github.com/rpcs3/rpcs3 | GPL-2.0 |

Ryujinx moved off GitHub. Use the `git.ryujinx.app` URL above; the GitHub Ryubing org has no
emulator repository. The GB/GBC core is chosen in Settings. Extension matching is case-insensitive.

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

## Executable resolution

For each core, Uemulator uses the first match:

1. **Override path** set on the Cores page ("Set path…"). Stored in Settings.
2. **Built binary** in `bin/<id>/`, produced by `npm run build:cores`.
3. **System install** locations, for example `/Applications/mGBA.app`, `/opt/homebrew/bin`,
   `/usr/bin`, or `%ProgramFiles%` on Windows.
4. **PATH** lookup by name, for example `mgba-qt`, `mgba`, `pyboy`, `azahar`, `Ryujinx`, `rpcs3`.

Project64 is Windows-only. On macOS and Linux it runs through `wine`, but only when `wine` is on
PATH and a `Project64.exe` is set as the override.

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
| `project64` | `bin/project64/` | Windows only: `git`, MSBuild (Visual Studio 2019 or newer). |
| `rpcs3` | `bin/rpcs3/` | `git`, `cmake` 3.28+, Qt 6.7+ (Widgets, Multimedia, Svg), SDL3, Vulkan, LLVM (system LLVM on macOS/Linux; built from the submodule on Windows), Clang 19+ or GCC 13+. Windows needs Visual Studio 2022 and the Vulkan SDK (`VULKAN_SDK`). `ninja` is needed on macOS and Linux. Upstream officially supports Windows and Linux. The macOS path is best-effort and has not been run here. |

The script prints the install command for each missing tool (for example `brew install cmake qt
sdl2` on macOS). Build directories live in `bin/.build/`, and nothing under `cores/` is edited.

## Where data is stored

- **Settings and library:** one JSON file, `uemulator.json`, in Electron's `userData` directory for
  the app (`app.getPath('userData')`). The app name comes from `package.json` (`uemulator`). On macOS
  this is `~/Library/Application Support/uemulator/`.
- Writes go to a `.tmp` file that is then renamed over the old one. If the file is not valid JSON,
  it is renamed to `uemulator.json.corrupt` and defaults are used.
- Built cores live in `bin/` (gitignored).

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
npm test          # node --test "tests/**/*.test.js" (134 unit tests)
npm start         # run the app
npm run dist      # electron-builder packaging
```

Add `?mock` to the renderer URL to preview the UI with sample data (`?mock=empty` for the empty state).

Layout:

```
src/main/        main.js (window, hardening), ipc.js (handlers + validation), store.js,
                 library.js (folder scan), systems.js (system table), processes.js (child processes)
src/main/cores/  one adapter per core + index.js (registry, executable resolution)
src/preload/     preload.js, the only bridge to the page (window.uemu)
src/renderer/    index.html, styles.css, app.js, state.js, ui.js, views/*.js, mock.js
scripts/         build-cores.mjs
tests/           node:test unit tests for the main-process modules
docs/design.md   UI design notes
cores/           upstream submodules (not edited)
bin/             built cores (generated, gitignored)
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
  to SIGKILL after 5 seconds. Running games are stopped when the app quits.

## Known limitations

- No embedded play. Games run in the emulator's own window, outside Uemulator.
- Cores are launched as external windows. Uemulator tracks the process and its logs only.
- No prebuilt core installer. Cores must be built locally or installed by hand.
- Build paths for cmake, .NET and RPCS3 are untested on the development machine. None of the six
  emulators is installed there, so real-emulator launches are untested.
- Licenses: each core keeps its own license (see table above). Uemulator is a launcher that starts
  those programs as separate processes. Check each core's license before you redistribute builds.
