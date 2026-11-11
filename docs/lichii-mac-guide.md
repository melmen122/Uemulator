# Lichii on this MacBook (M5): setup, games and tuning

A practical guide for running Nintendo Switch games through Uemulator and Lichii on this Mac.

**Not covered here:** `prod.keys` and Switch firmware. Where they come from and how they are installed is
outside this guide. Lichii's own error message when they are missing or do not match is in
section 7, so you can recognise it.

## 1. How the pieces fit

- **Uemulator** is the launcher: it scans your ROM folder (`~/Documents/roms_uem`), lists the games and starts
  the right emulator. For Switch games it runs `lichii -g <file>`. Ryujinx is the alternate Switch core.
- **Lichii** is the emulator. It has its own settings window, its own storage (below) and its own logs.
- **Switch 2 games** (`.nup`) are a separate system in Uemulator and use their own code path in Lichii.

## 2. Where things live

| What | Where |
|---|---|
| Lichii data (saves, NAND, keys, logs, screenshots) | `~/.local/share/eden/` |
| Global settings | `~/.config/eden/qt-config.ini` (backups next to it: `qt-config.ini.bak-*`) |
| Per-game settings | `~/.config/eden/custom/<title id>.ini` |
| Shader cache | `~/.cache/eden/` (can be 300+ MB; it makes later runs smoother) |
| Log of the last run | `~/.local/share/eden/log/eden_log.txt` (previous run: `eden_log.txt.old.txt`) |
| Crash dumps | `~/.local/share/eden/crash_dumps/` |
| Lichii that Uemulator launches | `~/Library/Application Support/Uemulator/emulators/lichii/` |
| A development build of Lichii (this repo) | `bin/lichii/` |

Always quit Lichii with **Cmd+Q**: the log and settings are only written completely on a normal quit.

## 3. Games, updates and DLC

- A Switch game id has the form `0100XXXXXXXXXYYY`. **Base game ends in `000`, its update in `800`,
  DLC in the following ids.** Example: Mario Kart 8 Deluxe base is `0100152000022000`, its update is
  `0100152000022800`.
- **An update file cannot run alone.** The update NSP in `roms_uem` holds only a patch (one 4.8 GB data
  file plus a ticket), not the game's data. It needs the base game.
- **Install updates and DLC into Lichii's NAND, then launch the base game.** In Lichii: *File → Install
  Files to NAND*, pick the update (and DLC). When you start the base game, Lichii applies what is installed.
- **Uemulator recognises updates and DLC.** A Switch `.nsp` whose title ID ends in `800` (update) or is
  add-on content is still listed, but its card says "Update: launch the base game" (or "DLC"), Play is
  disabled, and trying to start it shows an explanation instead of failing inside the emulator. Launch the
  base game instead. This only applies to `.nsp` files; an update that is not named with its title ID is
  identified from the ticket inside the file.
- Keep base games in `~/Documents/roms_uem`. A game that is still downloading shows as a
  `.crdownload` file and is ignored until it finishes.

## 4. Settings that matter on Apple Silicon

Lichii draws through Vulkan on top of Apple's Metal (MoltenVK). What was measured on this Mac, mostly with
Zelda: Ocarina of Time (Switch 2), and what usually carries over:

- **The GPU is normally the limit; the CPU threads are mostly idle.** Lowering the resolution is the main
  lever for games limited by pixels. In the settings, *Resolution* has steps ×0.25, ×0.5, ×0.75, ×1 and up.
  In the config file the value is the index (`resolution_setup`: 0 = ×0.25, 1 = ×0.5, 2 = ×0.75, 3 = ×1).
- **First play of a game or area stutters.** Shaders are compiled the first time they are needed and cached
  afterwards, so judge frame rate on the second session, not the first.
- **Your current non-default Lichii settings** (from `qt-config.ini`, for reference if you change things):
  presentation scaling filter changed, asynchronous shaders on, *native async draws* = Skip, reactive
  flushing off, GPU accuracy Low. A backup before each earlier change is in `~/.config/eden/`.
- **Per-game settings are safer than global ones.** In Lichii: right-click a game → *Properties*, or
  *Configure Current Game* while it runs. Only that game is affected. The OoT-specific profile
  (`scripts/oot-fast-profile.sh on|off|status`) uses exactly this and is fully reversible.
- To change a setting by hand, an override looks like this in the per-game file:
  ```
  resolution_setup\use_global=false
  resolution_setup\default=false
  resolution_setup=1
  ```
  (back to global: set `use_global=true` and delete the other two lines).

## 5. Measuring performance

- **In the game:** turn on Lichii's performance overlay (*Show Performance Overlay*) and look at the frame
  time, not only the fps number.
- **From the log:** lines containing `last 600 presents` give the true average frame time for each 600
  frames, plus the longest frame and how many were over 100 ms (stutters).
- **60 fps is 16.7 ms per frame; 30 fps is 33 ms.** A game that is always just above 16.7 ms looks like
  30 fps because of vsync.
- **Repeatable tests:** `scripts/bench/` replays a recorded session (currently Ocarina of Time only). It
  cannot run while another Lichii is open, and Uemulator's own Lichii must be closed first.

## 6. Switch 2 (`.nup`) games

- Ocarina of Time (Switch 2) runs, but slowly on this Mac: about 27 fps standing and worse while walking at
  its best setting, because the game's upscaler network is very heavy for Apple GPUs. Full measurements and
  the settings that helped are in `plan-metal-gpu.md`. For smooth OoT, use a PC.
- Lichii's own notes for these titles are in `cores/lichii/docs/nx2/`.

## 7. Troubleshooting

- **"The NCA file has a bad header"** (or "Decryption keys are missing" in the log): in practice this means
  Lichii cannot decrypt the file because the decryption data is missing or does not match the game or its
  update. It is not a corrupt download. Uemulator also warns about it before launching a Switch 1 game.
- **A game does not start from Uemulator:** open `eden_log.txt` and read the first `Critical` or `Error`
  line. Check you launched the base game, not an update or DLC file.
- **Black screen or frozen after a few seconds:** note whether the log keeps growing. Attach the log when
  asking Lichii's maintainers for help, after removing local file paths.
- **Controller:** configure it once under *Configure → Controls* in Lichii. Bluetooth controllers must be
  paired in macOS first. Lichii's own handbook is in `cores/lichii/docs/user/Controllers.md`; graphics
  options are explained in `cores/lichii/docs/user/Graphics.md`.
- **Disk space:** the shader cache and NAND grow with use. Keep a few GB free.

## 8. Quick checklist for a new Switch game

1. Put the base game (and update/DLC files) in `~/Documents/roms_uem`.
2. Open Lichii once, install updates and DLC (*File → Install Files to NAND*), and quit with Cmd+Q.
3. In Uemulator, rescan the library and launch the **base game**.
4. First session: let shaders build. Second session: check the frame time in the overlay.
5. If it is slow, lower the resolution for that game only, using the per-game settings.
