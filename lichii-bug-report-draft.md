# DRAFT: nothing has been posted. Review, redact paths, then paste into https://github.com/zortos293/Lichii/issues/new (template: "Gameplay Bug")

## Title

[GBug] Ocarina of Time (0400486024DEC000) on macOS / Apple M5: all-zero QMD → "Native QMD failed", GPU semaphore never released; build 125 stops at ~3 s, build 130 reaches ~260 presents then deadlocks

## Before submitting
- [x] I searched existing issues and found no duplicate (closest: #400 Orbitals, same QMD/semaphore signature on Windows; #595 closed, OoT boot hang on Linux; #660 / #744 / #1068 are other macOS reports whose logs I did not check for this error)
- [x] I'm using the latest build (build-130, pre-release; also tested build-125)
- [x] My game is legally dumped from my own console

## Emulator build
Lichii Development Build | nx2-build-130 (also reproduced on nx2-build-125). Official `lichii-macos-arm64.zip` from the releases page, sha256 verified.

## Regression
- [ ] This is a regression (it worked in an older build)

Not tested on builds before 125. One thing I can't explain: an earlier session on build-125 on this same Mac (17:57, ~9 min) reached steady 16.7 ms frames, per its log. After that I changed one setting (scaling_filter FSR3 → Bilinear and back, no effect) and every later launch of build-125 stops at ~3 s. I did not see the screen in either case, so I can't say what that earlier session actually displayed.

## Last known working build
_Unknown._

## Game
The Legend of Zelda: Ocarina of Time, Switch 2 version, `.nup` base game, title ID 0400486024DEC000 (v131072)

## Graphics card
Apple M5 (10-core GPU), Vulkan via MoltenVK. Build-125 log reported: MoltenVK 0.2.2209, Vulkan 1.3.334, "Missing required feature geometryShader / shaderCullDistance" and `VK_KHR_portability_enumeration` not available.

## Operating system
macOS Tahoe 26.5.2, MacBook Pro (base M5, 4P + 6E CPU cores), 16 GiB unified memory

## Steps to reproduce
1. Launch `lichii -g "<path>/The Legend of Zelda Ocarina of Time [0400486024DEC000][v131072].nup"` (also tried `EDEN_NX2_SPLIT=1` and `EDEN_NX2_SPLIT=0`; same result).
2. Settings: Vulkan, GPU accuracy Low, resolution 1x, async shaders on, async presentation on, ASTC GPU + BC3 recompression, memory layout 4 GB (log says Switch 2 program uses the 12 GiB layout), Dynarmic. Moving the shader cache aside changed nothing.
3. Build 125: the log goes silent about 3 s after boot, the window stays on "Launching...", and a sample of the process shows all six CPU-core threads, the GPU thread and EmuControlThread idle in `__psynch_cvwait` (the UI thread still pumps events).
4. Build 130: the log keeps going. About 260 presents happen, then each frame logs a 4 s timeout ("present #258 fence (1, 778) not reached ... now 775") while the fence stays at 775 and the target climbs to 800 over the next ~55 s; no progress.

Both builds log, ~2.0 to 3.4 s after boot, the first failing compute dispatch below. Notably **all 128 logged QMD words are zero** at `QMD=0x210af2df00` (build 130; the address differs between runs), as if the QMD memory has not been written/flushed yet when it is read, or the read goes through a mapping that doesn't see the write. On this unified-memory GPU I'd suspect a host-visible coherence or ordering issue rather than a bad title ID.

## Log / crash dump

(Attach the full `~/.local/share/eden/log/eden_log.txt` from a build-130 run after checking it for personal information. It contains local file paths.)

```
[   2.455645] HW.GPU <Error> video_core/engines/kepler_compute.cpp:442:ProcessNativeMethod: Native QMD failed: unsupported QMD version or queue
[   2.455654] HW.GPU <Error> video_core/engines/kepler_compute.cpp:452:ProcessNativeMethod: Native compute dispatch unsupported: method=0xb0, value=0x3, QMD=0x210af2df00, words=00000000,00000000,00000000,00000000,00000000,00000000,00000000,...
[   2.456394] Debug <Critical> video_core/memory_manager.cpp:355:operator(): .../src/video_core/memory_manager.cpp: assert false
[  16.638318] HW.GPU <Warning> video_core/engines/puller.cpp:281:CanResumeAcquire: Channel 1 waits on semaphore 0x2106e85000 (op 4, 0x1, now 0x0) for 2 s; ...
[  16.653159] HW.GPU <Warning> video_core/engines/puller.cpp:281:CanResumeAcquire: Channel 2 waits on semaphore 0x21144d1000 (op 1, 0x101, now 0x100) for 2 s; ...
[  18.682401] Service <Warning> ./core/hle/service/nx2_gsv.h:2115:WaitForFrame: nx2:vi2 present #258 fence (1, 778) not reached in 4 s (now 775)
[  71.176278] Service <Warning> ./core/hle/service/nx2_gsv.h:2115:WaitForFrame: nx2:vi2 present #264 fence (1, 800) not reached in 4 s (now 775)
```

Over the 71 s run the `memory_manager.cpp:355` assert logs ~1,361 times. Build 130 already includes #979 (semaphore mirror, merged 2026-11-09 07:42Z) and #436 (QMD release formats), so this looks like a remaining case of the #400 pattern, here on Apple GPUs.

Happy to test patches or a debug build on this M5 and send further logs.
