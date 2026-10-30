# Uemulator — Plan

One local desktop app (Node + Electron) that unifies six open-source emulators behind a single
game library, launcher and settings UI.

| System | Core | Upstream | Language / build | License |
|---|---|---|---|---|
| Nintendo 64 | Project64 | github.com/project64/project64 | C++ / MSBuild (Windows); macOS and Linux run the exe via Wine | GPL-2.0 |
| Nintendo Switch | Ryujinx (Ryubing) | git.ryujinx.app/ryubing/ryujinx (moved off GitHub) | C# / .NET SDK 10.0.301 (`cores/ryujinx/global.json`) | MIT |
| Nintendo 3DS | Azahar | github.com/azahar-emu/azahar | C++ / CMake + Qt6 | GPL-2.0 |
| Game Boy / Color | PyBoy | github.com/Baekalfen/PyBoy | Python (+Cython) / pip | LGPL-3.0 |
| GBA / GB / GBC | mGBA | github.com/mgba-emu/mgba | C / CMake | MPL-2.0 |
| PlayStation 3 | RPCS3 | github.com/rpcs3/rpcs3 | C++ / CMake + Ninja, Qt 6.7+ | GPL-2.0 |

## 1. Key decision: shell + process adapters, not a merged codebase

The six emulators use four languages and four build systems, and three of them have their own GUI
toolkits. Merging their source into one binary isn't realistic and would break their licenses'
separation. So the plan is:

- **Each emulator stays an untouched git submodule** under `cores/<id>`. This keeps upstream history,
  licenses and `git submodule update --remote` upgrades. Submodules are shallow, and Azahar's nested
  submodules are fetched only when that core gets built.
- **Electron is the unified front end**: library, ROM scanning, system detection, launching, per-core
  settings, controller hints, logs and core install status.
- **Each core is driven through an adapter**: a small JS module in the main process that knows how to
  find the core's executable, build its command line for a ROM, and report whether it's available.
  Games run as child processes spawned without a shell. Uemulator tracks their lifetime and streams
  logs to the UI.
- **Executable resolution order** for every core:
  1. a user override path in Settings
  2. a locally built binary in `bin/<id>/` (from `npm run build:cores`)
  3. well-known system install locations (e.g. `/Applications/mGBA.app`, Homebrew, `PATH`)
- **Platform reality**: Project64 has no native macOS or Linux build. On macOS/Linux its adapter runs
  the user-supplied `Project64.exe` through a Wine binary (`bin/wine/` on macOS, then the app-data link,
  then `wine` on PATH). It is Ready only when both the Wine binary and the exe are found; otherwise it
  shows Not installed with a hint. On Windows (x64) Project64 runs natively as `Project64.exe`, with no
  Wine. The other five run on macOS, Linux and Windows.
- **Windows x64**: the app builds as an NSIS installer and a portable zip (`npm run dist:win`, both
  unsigned). Core paths, PATH lookup, library folders and stop behaviour follow Windows rules (§3.4).
  Windows is not yet tested on a real machine.

### Phase 2 (not in v1)
- Embedded play: PyBoy runs headless in a Python bridge that streams frames into a `<canvas>`. mGBA
  gets a WASM build rendered in the renderer process.
- A one-click "install prebuilt core" button using official upstream releases, with checksum
  verification.
- Box art and metadata scraping, plus cloud save sync.

## 2. Repository layout

```
Uemulator/
  plan.md                     this file
  README.md
  package.json                electron, electron-builder; scripts: start, test, build:cores, dist
  .gitmodules                 cores/* (shallow)
  cores/                      upstream submodules (never edited)
    mgba/ pyboy/ project64/ azahar/ ryujinx/ rpcs3/
  bin/                        build output per core (gitignored)
  scripts/
    build-cores.mjs           `node scripts/build-cores.mjs [coreId...]` (per-core build + toolchain checks)
  src/
    main/
      main.js                 app lifecycle, BrowserWindow (hardened), IPC registration
      ipc.js                  all ipcMain.handle channels + argument validation
      store.js                JSON settings/library persistence in app.getPath('userData')
      library.js              ROM folder scanning + system detection
      systems.js              system table: id, name, extensions, coreId
      processes.js            running-game registry (spawn, log ring buffer, stop)
      cores/
        index.js              registry: list adapters, resolve, status
        mgba.js pyboy.js project64.js azahar.js ryujinx.js rpcs3.js
    preload/
      preload.js              contextBridge → window.uemu (typed, minimal API)
    renderer/
      index.html styles.css app.js   (no bundler; ES modules; strict CSP)
  tests/                      node:test unit tests for pure main-process modules
  docs/design.md              UI design source of truth
```

## 3. Contracts

### 3.1 Systems (`src/main/systems.js`)
| id | name | extensions | default core |
|---|---|---|---|
| `n64` | Nintendo 64 | .z64 .n64 .v64 | project64 |
| `switch` | Nintendo Switch | .nsp .xci .nca .nro | ryujinx |
| `3ds` | Nintendo 3DS | .3ds .cci .cxi .cia .3dsx .app | azahar |
| `gba` | Game Boy Advance | .gba | mgba |
| `gbc` | Game Boy Color | .gbc | mgba (alt: pyboy) |
| `gb` | Game Boy | .gb | mgba (alt: pyboy) |
| `ps3` | PlayStation 3 | .iso, EBOOT.BIN (only inside a `USRDIR` folder; matched by file name) | rpcs3 |

The user can choose which core handles GB/GBC (`mgba` or `pyboy`) in Settings. Matching is
case-insensitive on the file extension.

PS3 games are `.iso` files or `EBOOT.BIN` files directly inside a `USRDIR` folder (disc dumps:
`<Game>/PS3_GAME/USRDIR/EBOOT.BIN`; installed or PSN: `<TITLEID>/USRDIR/EBOOT.BIN`). `.pkg` is not
supported. The scanner does not descend into subfolders of `USRDIR`. The title is taken from the
sibling `PARAM.SFO` when readable, otherwise from the game folder name.

### 3.2 Adapter interface (`src/main/cores/<id>.js`)
```js
module.exports = {
  id: 'mgba', name: 'mGBA', systems: ['gba','gbc','gb'],
  platforms: ['darwin','win32','linux'],
  homepage: 'https://mgba.io', license: 'MPL-2.0',
  candidates(ctx) -> string[]        // absolute exe paths to probe, in priority order (built bin, system installs)
  buildArgs(romPath, opts) -> { command, args }   // opts: { exe, fullscreen, extra: {} }; pure, no I/O
}
```
`cores/index.js` adds the shared logic: `resolveExecutable(core, settings)` checks the override, then
the candidates, then `which`, and returns `{ status: 'ready'|'missing'|'unsupported', exe, source }`.
`unsupported` is returned only for platforms outside win32/darwin/linux.

Wine-run adapters (`wine: true`; Project64 today) resolve differently on darwin/linux. The `.exe`
comes from the override (or `candidates`, which is win32-only) and must be a regular file ending in
`.exe`. The Wine binary comes from `wineCandidates(ctx)` (`bin/wine/bin/wine`, then
`<userData>/runtime/wine/bin/wine`), then `winePathNames` on PATH. The result is
`{ status: 'ready'|'missing', exe, source, wine, wineSource: 'built'|'runtime'|'path'|null, detail? }`.
`detail` is a readable hint when the core is not ready.

`buildArgs` must be pure so it can be unit tested. For Wine-run adapters on non-win32 it returns
`{ command: wine, args: [exe, rom], env }`, where `env` holds `WINEPREFIX` plus fixed `WINEDEBUG` and
`WINEDLLOVERRIDES`.

The RPCS3 adapter always passes `--no-gui`, so the game boots without the main window and RPCS3
quits when the game closes. `--fullscreen` is added after it only when the setting is on. The
path is always last.

### 3.3 IPC (`window.uemu`, all return Promises)
| Method | Channel | Returns |
|---|---|---|
| `getCores()` | `cores:list` | `[{id,name,systems,status,exe,source,homepage,license,detail?}]`. `detail` is present only when a core has a hint (e.g. Wine runtime missing). |
| `setCorePath(id, path\|null)` | `cores:setPath` | updated core |
| `pickFile(kind)` | `dialog:pickFile` (`'exe'`\|`'rom'`) | path or null |
| `pickFolder()` | `dialog:pickFolder` | path or null |
| `getLibrary()` | `library:get` | `{ folders:[], games:[{id,title,path,system,size,lastPlayed,favorite}] }` |
| `addFolder(path)` / `removeFolder(path)` | `library:addFolder` / `library:removeFolder` | library |
| `rescan()` | `library:rescan` | library |
| `toggleFavorite(gameId)` | `library:favorite` | game |
| `launch(gameId, {coreId?})` | `game:launch` | `{ pid, sessionId }` or throws a readable error |
| `stop(sessionId)` | `game:stop` | `true` |
| `getSessions()` | `game:sessions` | `[{sessionId,gameId,coreId,pid,startedAt}]` |
| `getSettings()` / `setSettings(patch)` | `settings:get` / `settings:set` | settings |
| `onSessionEvent(cb)` | `game:event` (push) | `{type:'log'\|'exit', sessionId, line?, code?}` |
| `openExternal(url)` | `shell:openExternal` (http/https only) | `true` |

Settings shape: `{ fullscreen:false, gbCore:'mgba', corePaths:{ [coreId]: string|null }, theme:'system' }`.

### 3.4 Security baseline
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, no `remote`. The renderer
  runs under a strict CSP (`default-src 'self'`).
- Every IPC handler validates its arguments. `launch` accepts only a `gameId` that exists in the
  library and never a raw path or command from the renderer. Executables come only from the
  resolution order above.
- `child_process.spawn(cmd, args, { shell: false })`. No string-built commands.
- `openExternal` is allow-listed to `http:`/`https:`. Navigation and `window.open` are denied.
- Windows (`win32`) validators: a core executable must end in `.exe` (`validateCorePath`), because
  there is no shell and `.bat`, `.cmd` and `.lnk` cannot be spawned. PATH lookup (`defaultWhich`) also
  keeps only `.exe` and `.com`. A library folder cannot be a drive root (`C:\`) or the home folder. A UNC
  share root (`\\nas\roms`) is allowed. `$RECYCLE.BIN` and `System Volume Information` are skipped.
- Windows stop (`processes.js`): the stop request is `taskkill /PID <pid> /T` using the absolute path
  `%SystemRoot%\System32\taskkill.exe`. After `KILL_GRACE_MS` (5 s) it runs `taskkill /PID <pid> /T /F`.
  A failed graceful request escalates to `/F` at once. The app menu is hidden on Windows.
- Adapter `env` is accepted only for the allowlist `WINEPREFIX`, `WINEDEBUG`, `WINEDLLOVERRIDES`
  (`ENV_ALLOWLIST` in `processes.js`). Values must be strings with no NUL and at most 4096 chars. A
  Wine child inherits the app environment minus `WINELOADER` and `DYLD_*`/`LD_*`. The renderer never
  sets env.
- Wine prefix: `<userData>/wine/<coreId>` (Project64: `wine/project64`). `game:launch` creates it with
  mode 0700 only after `buildArgs` accepts the request. Process exit is reported after 1.5 s even if a
  lingering `wineserver` still holds the pipes (`EXIT_CLOSE_GRACE_MS`).

## 4. Build scripts (`scripts/build-cores.mjs`)
| Core | Steps | Toolchain |
|---|---|---|
| mgba | `cmake -B bin/.build/mgba -DBUILD_QT=ON -DBUILD_SDL=ON` → `cmake --build` → `cmake --install --prefix bin/mgba`. Qt target is `mGBA` (`mGBA.app` on macOS and Windows) and `mgba-qt` on Linux; SDL frontend is `mgba`. `BUILD_QT` silently falls back to OFF if Qt is not found. | cmake, Qt 5/6 and/or SDL2 |
| azahar | `git -C cores/azahar submodule update --init --recursive --depth 1`, then out-of-tree `cmake -B bin/.build/azahar -DENABLE_TESTS=OFF -DENABLE_QT=ON`, build target `citra_meta` (executable `azahar`) → copied to `bin/azahar` | cmake, Qt 6, SDL2, a C++20 compiler |
| ryujinx | `dotnet publish cores/ryujinx/src/Ryujinx/Ryujinx.csproj -c Release -r <host RID> --self-contained true -o bin/ryujinx`. Executable `Ryujinx` (`Ryujinx.app/Contents/MacOS/Ryujinx` only for a system .app install). | .NET SDK 10.0.301 (`global.json`, `rollForward: latestFeature`) |
| pyboy | Built from a copy in `bin/.build/pyboy-src` so pip never writes into `cores/`: `python3 -m venv bin/pyboy/venv` → `pip install <copy>` (deps: numpy, pysdl2, pysdl2-dll) | python3 ≥ 3.9, a C compiler (Cython) |
| project64 | Windows: `git -C cores/project64 submodule update --init --recursive --depth 1` (GLideN64, SDL), then `msbuild Project64.sln /m /p:Configuration=Release /p:Platform=x64` → `cores/project64/Bin/x64/Release` copied to `bin/project64`. macOS: no Project64 build. Downloads Wine 11.18 (Gcenx `macOS_Wine_builds`, x86_64, ~190 MB), checks SHA-256 before extraction, extracts to `bin/wine/`, and symlinks `<userData>/runtime/wine` to it. A smoke test (`wine cmd /c ver`) is reported but not fatal. Linux: not built here (uses `wine` from PATH). | Windows: git, Visual Studio 2019+ (MSBuild). macOS: Rosetta 2 (Apple Silicon), tar, curl. |
| rpcs3 | Nested submodules fetched selectively: `git -C cores/rpcs3 submodule update --init --recursive --depth 1`, skipping LLVM, SDL, curl, zlib and feralinteractive on macOS/Linux (Windows fetches all). Then out-of-tree `cmake -S cores/rpcs3 -B bin/.build/rpcs3 -G Ninja` (macOS/Linux, system LLVM, system SDL3) or `-G "Visual Studio 17 2022" -A x64` with `BUILD_LLVM=ON` (Windows) → `cmake --build --target rpcs3` → `<build>/bin` copied to `bin/rpcs3`. Executable: `bin/rpcs3/rpcs3.app/Contents/MacOS/rpcs3` on macOS, `rpcs3` on Linux, `rpcs3.exe` on Windows. Upstream officially supports Windows and Linux; macOS is best-effort and untested here. | CMake 3.28+, Ninja (macOS/Linux), Qt 6.7+, SDL3, Vulkan, LLVM, Clang 19+ / GCC 13+. Windows: VS 2022 and the Vulkan SDK. |

The script checks for each toolchain first. When one is missing it prints the exact install command
(e.g. `brew install cmake qt sdl2`, `brew install --cask dotnet-sdk`) and skips that core, so one
missing toolchain never fails the others.

## 5. UI (renderer)
- **Library** (default view): a grid of game cards, filtered by system tabs (All · N64 · Switch ·
  3DS · GBA · GB/GBC · PS3), with search, favorites and recently played. It shows an empty state with
  "Add ROM folder" when there are no games.
- **Game card**: title, system badge and Play. Play is disabled with a reason when the core is
  missing. Double-click also launches.
- **Cores** view: one card per emulator showing status (Ready / Not installed / Unsupported), the
  resolved path and its source, plus "Set path…", "Reset" and links to the homepage and license.
  The RPCS3 card also notes that PS3 firmware must be installed inside RPCS3.
- **Running** panel: active sessions with a live log tail and Stop.
- **Settings**: ROM folders, fullscreen on launch, GB/GBC core choice and theme.
- Keyboard: `/` focuses search, Enter launches the selected game, and arrow keys move the grid
  selection. The UI follows the system light/dark theme.

## 6. Team split & order
1. Orchestrator: repo init, submodules, this plan.
2. In parallel, on disjoint files:
   - **backend**: `package.json`, `.gitignore`, `src/main/**`, `src/preload/**`, `scripts/**`.
     It verifies each core's real CLI flags and build steps by reading `cores/<id>` source.
   - **frontend**: `src/renderer/**`, `docs/design.md`, built against contract §3.3.
   - **tester**: `tests/**`, covering systems detection, adapter `buildArgs`, executable resolution
     (with injected fs), library scanning (temp dirs) and IPC argument validation.
3. **check**: `npm install`, `npm test`, a syntax check, and an Electron smoke launch.
4. **reviewer**: IPC/spawn/path-handling security (critical surface).
5. **documenter**: README.md.

## 7. Definition of done (v1)
- `npm install && npm start` opens the app on macOS, with no console errors.
- Adding a folder of ROMs lists them with the correct systems.
- The Cores view correctly reports each core's status on this machine.
- Launching a game with a ready core spawns the emulator, streams its logs, and lets you stop it.
- `npm test` passes (runs `node --test "tests/**/*.test.js"`).
- `node scripts/build-cores.mjs mgba` (etc.) either builds or prints actionable missing-toolchain steps.

## 8. Status
- v1 implemented: Electron shell, game library, six core adapters, build script, 134 unit tests.
- Project64 on macOS via Wine: `build:cores -- project64` installs the Wine runtime, and the adapter
  resolves it per §3.2. Only Wine's own programs have been run. Project64 has not been run under Wine
  yet. `npm test` now runs 255 unit tests.
- PS3 / RPCS3 added: system table entry, EBOOT.BIN/USRDIR scanning, adapter, build script entry,
  PS3 UI filter and badge. The RPCS3 build has not been run on the dev machine.
- Windows x64 support added: `win32` adapter paths (`cores/winpaths.js`), `.exe`-only core paths,
  taskkill stop, `window.uemu.platform`, and `%APPDATA%\uemulator\` data. The NSIS installer
  (per-user, choosable folder, desktop and Start menu shortcuts) and a portable zip are built by
  `npm run dist:win`. Both are unsigned. Not yet run on a real Windows machine.
- Not yet done: embedded play (phase 2), prebuilt core installer, real-emulator launch tests (none of
  the six emulators, RPCS3 included, is installed on the dev machine), and a Windows hardware test.
