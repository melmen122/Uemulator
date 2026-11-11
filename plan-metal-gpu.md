# Plan: make Zelda OoT (Switch 2) playable on this Mac by fixing how Lichii renders on Metal

> Lives next to `plan.md` (the Uemulator app-architecture plan, left untouched). Rename if you want
> this one to be the main plan. Nothing here has been built or changed yet; this is the plan only.

**Goal.** `The Legend of Zelda: Ocarina of Time` (Switch 2 `.nup`, `0400486024DEC000`) runs at a
playable frame rate in Lichii on this MacBook Pro (Apple M5, 10-core GPU, 16 GiB). The OS changed
from macOS 26.5.2 (all numbers in §2) to **27.2.1** on 2026-11-10; §2 is therefore history and the
baseline is being re-measured (Phase 0).

**Done means** (measured with the replay harness, §6): median frame time in the slow gameplay phase
≤ 50 ms (≥ 20 fps) in two consecutive runs, no new crashes or missing geometry. Stretch: ≤ 33 ms.
Today: ~130 ms median (7.1 fps).

**Status (2026-11-10, latest).** The premise below (mesh shaders / native Metal) turned out not to be the
bottleneck. Measuring found the real one: the game's end-of-frame upscale "network" ran as ~60 ms compute
jobs (46% of GPU time). Lichii's existing "Ocarina of Time anti-aliasing: No sharpening" setting skips
it: **133 ms → 59.6 ms (7.2 → 16.8 fps), Max Resolution on**, and with host resolution ×0.5 on top
**→ 37 ms (about 25 fps)**, which meets the Done target in two runs (§2d). The slow phase is now
fragment-bound. Not yet applied to the user's real Lichii config: `scripts/oot-fast-profile.sh on`
does it (OoT only, with backup). Sections 1, 4 and 5 are kept as the original analysis and are
superseded where §2b–§2d say so.

---

## 1. Verdict first: what the measurements say about "do it on Metal"

The request is to attack option 3 from the earlier session: a native Metal path, or mesh shaders
through MoltenVK. Two findings shape the plan.

1. **Mesh shaders on Metal are not months of from-scratch work any more.** Metal has had mesh
   render pipelines since macOS 13. SPIRV-Cross already translates mesh and task shaders to Metal
   (merged Nov 2024). A MoltenVK fork already exposes `VK_EXT_mesh_shader` on Metal (mesh stage
   only) and reports NieR:Automata going from 7.5 to 30 fps against a compute fallback like
   Lichii's. So the mesh part is **integration work on top of existing code**, about a few days.
2. **But the recorded OoT data says mesh shaders are not what makes OoT slow.** Skipping every
   mesh draw gains only 8–13%. Meshes can account for at most about that much, so a perfect native
   mesh path cannot take OoT from 7 fps to playable. Most of the ~130 ms per frame is something
   else, and nobody has found out what yet.

So the plan is **measure first, then pick the track the data supports**. I will not start a native
Metal backend before the data says translation overhead is the cost. The mesh work stays in the
plan, because it is cheap, real and helps other Switch 2 games, but it is not the critical path for
OoT unless the census in Phase 1 contradicts the 8–13% bound.

## 2. Evidence already collected (replay of a recorded OoT session, patched local Lichii build)

Source: the earlier "Lichii emulator integration" session, 26 variants, ~3.5 min each. Slow phase =
gameplay after the intro.

| Variant | Slow-phase median | fps | Reading |
|---|---|---|---|
| baseline (two runs) | 130 / 135 ms | 7.1 / 6.8 | run-to-run noise is about ±4% |
| all mesh draws skipped (`no_mesh`) | 123 ms | 7.7 | mesh fallback costs ≤ 8–13% |
| resolution ×0.5 (4× fewer pixels) | 111 ms | 8.6 | pixels are about 15–20% of the cost |
| resolution ×0.25 (16× fewer pixels) | 102 ms | 9.1 | **~100 ms/frame is not pixels** |
| PR #861 (removes CPU waits on GPU fences) | 121 ms | 7.6 | the CPU waits are a symptom, not the cause |
| thread QoS, GPU-thread split/spin, vsync modes, MoltenVK submit/semaphore/math/argument-buffer settings, FXAA/post off, ASTC on CPU | 125–136 ms | 6.4–7.9 | no effect |
| PR #768 on top of #861 | 150 ms | 3.7–6.3 | worse |

GPU counters while slow (`ioreg` IOAccelerator PerformanceStatistics): **Device 89%, Renderer 86%,
Tiler 62%** (smooth intro: 67 / 63 / **30**). The GPU is the limit. The **Tiler share doubling
points at vertex and geometry load (or many small passes), not fragment work**.

Still unknown, and the whole point of Phase 1: **which GPU work costs the ~100 ms.**
Unfinished experiment: "Max Resolution (built-in)" off and GPU Clocks Normal (sweep11) was running
when that session ended. The earlier `gpuclock_normal` run went off track (it ended at frame 1995).

## 2b. Results since the plan was written (macOS 27.2.1, harness in `scripts/bench/`)

Slow-phase frame time, one ~5 minute replay per row (raw files in `bin/.bench/results/`).

| Run | Median | fps | GPU Device / Renderer / Tiler |
|---|---|---|---|
| baseline ×3 | 132 / 128 / 140 ms | 7.0–7.2 | 89 / 88 / 65–68 % |
| **Max Resolution (built-in) off** ×2 | 83 / 81 ms | 11.3 / 12.1 | 88–90 / 87–90 / 78 % |
| Max Resolution off + GPU Clocks Normal | 82 ms | 11.8 | 93 / 92 / 82 % |
| GPU Clocks Normal alone | 139 ms | 6.8 | 90 / 90 / 75 % |
| Max Resolution off + host resolution ×0.5 | 81 ms | 11.2 | 88 / 87 / 80 % |
| Max Resolution off + host resolution ×0.25 | 81 ms | 11.4 | n/a |

What this says:
1. **Max Resolution off is a real win: −38% frame time** (two confirming runs, noise ±5%). It lets the game
   scale its own resolution down under load, like a real Switch 2. Costs image sharpness. Not yet applied to
   the user's real Lichii config.
2. **With it off, host resolution stops mattering** (×1, ×0.5, ×0.25 all ≈ 81 ms). The remaining ~81 ms
   per frame is **not pixel work**. The GPU is still ~90% busy with the Tiler at ~80%.
3. **Gate 1 evidence: render-pass restarts.** Lichii's own log (`Scheduler per second: ... render passes`,
   `Render pass ends N/s at file:line`) shows ~4–6 render passes per frame in the smooth intro and **~180 per
   frame in the slow phase (baseline), ~220 per frame with Max Resolution off**, with ~50 queue submits per
   frame. Ends by cause, per frame (baseline / Max Resolution off):

   | Cause | Source | Baseline | Max Res off |
   |---|---|---|---|
   | mesh fallback compute before each emulated mesh draw | `vk_graphics_pipeline.cpp:1295` | ~47 | ~47 |
   | query barriers | `vk_query_cache.cpp:1684` | ~32 | ~32 |
   | clears that cannot be deferred | `vk_rasterizer.cpp:1951` | ~28 | n/a |
   | image copies | `vk_texture_cache.cpp:2608` | ~23 | **~71** |
   | buffer copies | `vk_buffer_cache.cpp:600,659` | ~10 | ~10 |

4. **Hypothesis H1, tested and REFUTED in its strong form.** H1: each pass costs ~0.2–0.3 ms of fixed GPU
   time on Apple's tile-based GPU, so ~220 passes ≈ most of the 81 ms. Prediction: skipping every mesh draw
   (−47 passes/frame) should save ~12 ms. **Measured (`maxres_off_nomesh`): 80.2 ms vs 81–83 ms, i.e. nothing**
   (GPU still 88/87/78 %). So the mesh-induced passes are cheap, and the pass *count* is not by itself the
   bottleneck. Other pass causes (image copies, query barriers, clears) are not excluded, but "many passes =
   slow" is no longer a safe working assumption.
5. **Consequence for the tracks:** nothing is promoted on pass count alone. **Native mesh shaders (Track B)
   are now measured at ≈ 0–3% of frame time at the new speed (and 8–13% at the old one): demoted to "only
   for other Switch 2 titles".** What costs the ~81 ms is still unknown, so the next step is direct GPU
   timing (Phase 2 step 4, Metal System Trace / GPU capture), not another guess.

Notes found on the way:
- The Lichii binary in `bin/lichii` was built from `bin/.build/lichii-src` at commit `3dae119`, while the
  submodule pin is `0ab7736`. Patches are authored against `3dae119` in `bin/.build/lichii-work`
  (scratch commit `fd69334` = 0001–0005 applied). Fix by bumping the pin or documenting `LICHII_SRC`.
- Xcode finished installing (3.7 GB) mid-sweep; until its license is accepted the system `python3` shim
  refuses to run, so the harness now picks a Homebrew Python (`PY` in `env.sh`).

## 2c. Metal System Trace of the slow phase (Xcode 27.2 `xctrace`, 6.9 s window, Max Resolution off)

`BENCH_XCTRACE=6 scripts/bench/replay.sh <label>` attaches Instruments' Metal System Trace (no extra
setup needed; Developer Mode was not required). Joined with MoltenVK's own encoder labels:

| GPU channel | Share of window | Biggest contributor |
|---|---|---|
| **Compute** | **57%** | **53 coalesced encoders `vkCmdDispatch & vkCmdFillBuffer & vkCmdDispatch`, 50–74 ms each = 3.18 s = 46% of the window**, one every ~130–200 ms |
| Compute (rest) | ~12% | 5,969 other dispatches, 0.65 s; copies/queries are negligible (< 0.1 s each) |
| Fragment | 22% | 12,799 render encoders, 0.94 s, plus ~0.6 s of compositor work |
| Vertex | 6% | 12,799 render encoders, 0.27 s |

Any-channel busy 68% of the window while traced. Compute shaders in the trace are 300–500 KB of GPU
code each. **Native mesh shaders, render-pass counts and host resolution are all small next to this.**

**Hypothesis H2 (to be confirmed by the runs below):** these jobs are the game's end-of-frame upscale
chain. Lichii's own `docs/nx2/oot-network-bypass.md` describes it: a prepass (`8475d671e6967428`), a
heavy dispatch (`d9ee412f00ce399a`), a tensor "network" (`42593194bb0b2b32`) and a sharpening output pass
(`da6df3e54c716df2`), all on the tonemapped image. The setting **"Ocarina of Time anti-aliasing: No
sharpening"** (`oot_anti_aliasing=1`) skips the prepass and the network (the doc measured 41 → 50 fps on
an RTX 5090). The earlier sweeps never tried this setting (they only changed generic FXAA/post options).
Caveats from the doc: the shader hashes were found with the Max Resolution patch on; the heavy dispatch
still runs with its result unused; some banding in dark tones.

`scripts/bench/sweep-network.sh` runs No sharpening with Max Resolution on and off.

## 2d. Result of the network bypass, and what is left

| Run | Slow-phase median | fps | GPU Device / Renderer / Tiler |
|---|---|---|---|
| baseline ×3 | 132 / 128 / 140 ms | 7.0–7.2 | 89 / 88 / 65–68 % |
| **No sharpening (`oot_anti_aliasing=1`), Max Resolution on** | **59.6 ms** | **16.8** | 83 / 81 / **17 %** |
| No sharpening, Max Resolution off | 80.2 ms | 12.1 | 89 / 87 / 72 % |

Host resolution on top of the bypass (fragment-bound now, so it pays; `sweep-bypass-res.sh`):

| Run | Slow-phase median | mean fps | p95 |
|---|---|---|---|
| No sharpening, ×0.75 | 49.3 ms | 17.1 | 74 ms |
| **No sharpening, ×0.5, run 1** | **37.2 ms** | **24.9** | 44 ms |
| **No sharpening, ×0.5, run 2 (confirmation)** | **40.1 ms** | **22.8** | 47 ms |

**The Done target (median ≤ 50 ms in two consecutive runs) is met by No sharpening + ×0.5** on the replay.
Still unchecked: how it looks, and "no new crashes or missing geometry" (visual). Patch 0007 adds
`EDEN_BENCH_SHOT_SECONDS` so the harness can take Lichii's own screenshots at the same replay moments for
a side-by-side comparison. The settings are NOT yet applied to the user's real Lichii config (awaiting OK).

H2 confirmed: the giant compute jobs were the upscale network chain. With Max Resolution off the bypass
does nothing, because its shader keys are those of the full-size chain (as `docs/nx2/oot-network-bypass.md`
warns); the game then runs a different 3/4-scale chain.

Metal System Trace of the bypass run (8.97 s window; 69 ms/frame while traced):

| Channel | Share of window | |
|---|---|---|
| **Fragment** | **62%** | 27,037 render encoders, 6.26 s (mean 0.23 ms, max 9.2 ms) |
| Compute | 25% | no job ≥ 20 ms any more; 14,571 small dispatches 1.8 s, buffer copies 0.5 s |
| Vertex | 6% | |

So with the network gone the game is **fragment-bound** (pixel cost), the opposite of before.

### Final sweep on the patched build (`sweep-visual.sh`, patches 0001–0007, 2 screenshots per run)

| Run | Slow-phase median | mean fps | p95 |
|---|---|---|---|
| default (Game anti-aliasing, ×1) | 154.6 ms | 6.2 | 171 ms |
| No sharpening, ×1 | 52.6 ms | 18.3 | 66 ms |
| No sharpening, ×0.75 | 46.6 ms | 20.5 | 51 ms |
| **No sharpening, ×0.5** | **36.7 ms** | **26.2** | **43.5 ms** |
| No sharpening, ×0.5, heavy dispatch kept (patch 0006 off) | 35.1 ms | 27.9 | 38 ms |

- **Patch 0006 is rejected**: skipping the heavy dispatch gives no gain (35.1 vs 36.7 ms). Moved to
  `patches/lichii/rejected/`. Baseline noise on this machine is ±10% (128–155 ms across five runs).
- **The slow phase is now 4× faster at ×0.5 (155 → 37 ms) and 3× at full resolution (155 → 53 ms).**
- **Visual check (Lichii's own screenshots, patch 0007).** No sharpening at ×1 (1920×1080) looks clean and
  detailed in Kokiri Forest: foliage, rock and Link render normally, no visible artifacts or missing
  geometry. ×0.5 renders at 960×540 before the display scales it up: softer, still good. A same-scene
  pixel diff is not possible: the TAS replay advances with wall-clock time, so a faster config ends up
  further along in the game. The screenshots are in `bin/.bench/results/v_*.shots/`.
- **Per-game config verified.** With the override written the way Lichii stores it, a boot logs
  `MC Renderer.oot_anti_aliasing: NoSharpening` and `MC Renderer.resolution_setup: Res1_2X`.
  `scripts/oot-fast-profile.sh on|off|status` writes and reverts exactly those two keys in
  `~/.config/eden/custom/0400486024DEC000.ini` (one-time backup; tested on a scratch copy only).

### Can it reach 60 fps? (user requirement) Measured: no, not by resolution

Lichii's periodic `last 600 presents` lines give the **true** average frame time (the `Nx2Stutter` lines
only log frames slower than ~33 ms, so medians from them are biased once most frames are fast).
Steady gameplay, No sharpening on:

| Resolution | Steady avg frame | fps | GPU Device busy |
|---|---|---|---|
| ×1 | 52 ms | 19 | ~90% |
| ×0.5 | 36 ms | 27–28 | ~85% |
| **×0.25** | **27–30 ms** | **33–37** | ~76% |
| (intro, every resolution) | 16.8 ms | 59–60 | n/a |

- The game itself reaches 60 fps in the intro at every resolution, so 60 is the game's target.
- Frame time vs pixels: 52 → 36 → 27 ms for 1 → 1/4 → 1/16 of the pixels. **The non-pixel floor is ~25 ms
  (~40 fps max).** Resolution alone cannot reach 16.7 ms.
- At ×0.25 the GPU is only ~76% busy and Lichii's GPU threads are busy under 12 ms of a 27–35 ms frame
  (`busy=front:8,back:12,worker:2`), so the remaining wait is the GPU's own fixed work or the emulated game
  CPU. Per-thread CPU check of that: see the result recorded below (`v_bypass025_cpu`).
- **Walking is worse than standing**: windows with big stalls (max 2.4–3.4 s, 27–41 of 600 frames over
  100 ms, avg 43–46 ms) at the start of the replay's movement. These are first-time shader/pipeline builds
  (each replay starts from the snapshot's shader cache, a real install keeps its cache between sessions).

**Recommendation.** For OoT only: No sharpening + ×0.5 (about 25 fps, steady), or ×0.75 for a sharper
picture at about 20 fps. Not yet applied to the user's real config.

**Remaining ideas (not needed to meet the target):**
1. A bypass for the 3/4-scale chain (game state with the Max Resolution add-on off), by finding its
   prepass/network program keys. Would combine the game's own lower resolution with no network.
2. Remaining GPU cost at ×0.5 is fragment + ~20% small dispatches (Metal trace). Another trace would
   show what is left if more than ~27 fps is wanted.
3. The Metal/MoltenVK tracks of §4 are only worth re-opening for other Switch 2 titles that draw with
   task/mesh shaders; they are not needed for OoT.

## 3. What already exists (reuse, don't rebuild)

- **Metal:** mesh shaders need Apple7+ / macOS 13 / MSL 3.0. The M5 qualifies.
- **SPIRV-Cross (MoltenVK's SPIR-V → MSL step):** mesh and task shader PRs #2400/#2401/#2402
  merged around Nov 2024 ([issue #2375](https://github.com/KhronosGroup/MoltenVK/issues/2375)).
- **Upstream MoltenVK:** no `VK_EXT_mesh_shader`. [PR #1845](https://github.com/KhronosGroup/MoltenVK/pull/1845)
  was a 2023 WIP. #2375 is open with no PR linked. Open semantic gap: `emitMeshTasksEXT`
  terminates a task shader in Vulkan, but not in Metal.
- **`eezouhong/MoltenVK`** (Apache-2.0, public, Ryujinx/MeloNX lineage). Branch
  `metal4/1.4.2-ryujinx.6` has [PR #23](https://github.com/eezouhong/MoltenVK/pull/23), merged
  2026-09-29: `VK_EXT_mesh_shader` on Metal mesh render pipelines, **mesh stage only** (no task
  shaders, no `DrawMeshTasksIndirectCount`, no mesh queries, no multiview). Reported limits: 124
  output scalars, `maxMeshOutputMemorySize` 30208, `maxMeshOutputComponents` 120. It was tested on
  NieR:Automata via MeloNX (7.48 → 29.99 fps, render pass begins 377 → ~50 per frame). The author's
  own numbers, not independently reproduced. [PR #59](https://github.com/eezouhong/MoltenVK/pull/59)
  adds a Metal IR route that needs a private Mesa fork. **We do not use that route.** No prebuilt
  releases are visible on the repo page.
- Also `ProjectKML/MoltenVK@88e5f00` (older mesh-shader proof of concept, task shaders untested).
- **KosmicKrisp** (Mesa Vulkan-on-Metal): Vulkan 1.4 conformant, but mesh shaders are only on its
  wish list. Not an option today.
- **Lichii today:**
  - Bundles `V380-Ori/Ryujinx.MoltenVK v1.4.1-ryujinx` ([cpmfile.json:172](cores/lichii/cpmfile.json));
    in the built app it is one file, `Contents/Frameworks/libMoltenVK.dylib`. It can be swapped
    (`YUZU_USE_BUNDLED_MOLTENVK=OFF` + `MOLTENVK_LIBRARY`, [externals/CMakeLists.txt:450](cores/lichii/externals/CMakeLists.txt)).
  - Native mesh path only if the device has **both** `taskShader` and `meshShader`
    ([vulkan_device.h:721](cores/lichii/src/video_core/vulkan_common/vulkan_device.h)). The fork
    exposes mesh only, so Lichii would ignore it.
  - Otherwise task/mesh pipelines are either skipped (draw dropped, [vk_pipeline_cache.cpp:2251](cores/lichii/src/video_core/renderer_vulkan/vk_pipeline_cache.cpp))
    or run through a compute "mesh as compute" prototype with narrow eligibility rules
    ([vk_pipeline_cache.cpp:2300](cores/lichii/src/video_core/renderer_vulkan/vk_pipeline_cache.cpp),
    [emit_spirv_mesh.cpp](cores/lichii/src/shader_recompiler/backend/spirv/emit_spirv_mesh.cpp)).
    Pipelines that are not eligible draw nothing, so some OoT geometry may be missing on Mac.
  - `EDEN_NX2_FORCE_MESH_FALLBACK=1` forces the fallback ([vulkan_device.cpp:1745](cores/lichii/src/video_core/vulkan_common/vulkan_device.cpp)).
  - Local patches live in [patches/lichii/](patches/lichii/) (0001–0005, applied by `scripts/build-cores.mjs`).

## 4. Options, with honest cost and gain

| Option | Cost | Gain bound for OoT | Verdict |
|---|---|---|---|
| **A. Native Metal backend** (new `renderer_metal`, MSL backend in the shader recompiler) | months; Lichii's Vulkan renderer and recompiler are very large | unknown; only helps if MoltenVK translation is the cost | **Last resort.** Enter only if Phase 2 proves translation overhead ≥ 50% of GPU time *and* MoltenVK patches cannot fix it |
| **B. Mesh shaders via the MoltenVK fork + Lichii mesh-only path** | build MoltenVK (needs Xcode) + ~3–5 days of Lichii work | ≤ 8–13% for OoT by the `no_mesh` bound; large for mesh-heavy titles | **Do, but gated** by the census |
| **C. Cheaper render passes / fewer encoder splits (TBDR-aware)** | days, inside Lichii | unknown; plausible if the census shows hundreds of passes per frame | Decided by Phase 1 |
| **D. Cut vertex/geometry load** (LOD, draw filtering, game add-ons) | hours–days | unknown; Tiler 62% points here | Decided by Phase 1 |
| **E. Drop-in newer MoltenVK** (the fork's Metal 4 command backend) | one build, one file swap | unknown; free A/B | **Do early**, it is the cheapest translation-layer test |

## 5. Phases, gates and pass/fail numbers

Every phase ends in a number from the harness. A change counts as real only if it beats baseline by
**≥ 8% median frame time in two runs** (noise is ±4%). Stop a track when its gate fails.

### Phase 0: prep (about 1 hour, no Xcode)
1. **DONE: harness moved into the repo** as [scripts/bench/](scripts/bench/README.md). The original
   lived in a session temp folder and was already deleted by the OS update, so it was rebuilt
   from the earlier session's transcript (`replay.sh`, `summarize.py`, `gpu_poll.sh`, the TAS
   recording) and made path-independent. The data snapshot is re-taken from your current Lichii
   data into `bin/.bench/base` (gitignored). Caveat: the real OoT saves changed after the first
   snapshot, so the replay must be checked to reach the slow phase again (baseline run 1).
2. Re-establish baseline: 3 runs of the current patched build. Record median, p95, and
   `ioreg` Device/Renderer/Tiler.
3. Finish the unfinished sweep: `maxres_off`, `gpuclock_normal` (re-run, last one went off track),
   and both together. If one of these alone gives ≥ 8%, ship it as a per-game default in the
   Uemulator launch settings and keep going.
4. **Decide patches 0002–0004** (thread QoS, spin tuning, drain interval): the earlier session
   measured "no difference". Drop them from `patches/lichii/` so later A/B runs are clean.

### Phase 1: frame census (about half a day, no Xcode)
New patch `0006-frame-census.patch`, behind `EDEN_NX2_FRAME_CENSUS=1`, counts per second:
- draws (direct / indexed / indirect / instanced) and the **total vertices submitted**
  (`vertex_count × instances`, the Tiler load);
- compute dispatches, split by pipeline (guest compute, mesh fallback, ASTC/BC3 decode, buffer
  cache helpers);
- **render pass begins and the reason each one ended**: hook
  `Scheduler::RequestRenderpass` / `EndRenderPass`
  ([vk_scheduler.cpp:428,886](cores/lichii/src/video_core/renderer_vulkan/vk_scheduler.cpp);
  `RequestRenderpass` already takes a `std::source_location`), plus `Scheduler::Flush` (:166);
- mesh/task draws and how many pipelines were skipped as ineligible;
- bytes uploaded, texture conversions, queue submits, query/readback flushes.

Hook points: `RasterizerVulkan::Draw` (:1256), `DrawIndirect` (:1494), `DispatchCompute` (:2042) in
`vk_rasterizer.cpp`. Compare the **smooth intro vs the slow phase** from one replay: the category
whose count or volume jumps with the Tiler is the suspect.

**Attribution by removal** (the technique that produced `no_mesh`; each is one 3.5-minute run):
skip draws above N vertices; skip draws into the largest render target; skip each compute
category; skip texture-conversion work. Record the fps change and the `ioreg` split for each.

Also try `MTL_HUD_ENABLED=1` (Metal HUD, works without Xcode) and MoltenVK's performance logging
(`MVK_CONFIG_PERFORMANCE_LOGGING_FRAME_COUNT`; may be compiled out of the bundled dylib, skip
if so).

### Gate 1: pick the track (decision table)
| Census / removal result | Go to |
|---|---|
| Removing one draw or compute category gives ≥ 25% | **Fix that thing** (Track D or C), often a Lichii-side change |
| Hundreds of render pass begins per frame, most ended by compute/copy/query | **Track C** (merge passes, hoist compute) |
| Vertex totals explode in the slow phase | **Track D** (what LOD or draw set is it? GPU Clocks, add-ons, culling) |
| Mesh share ≥ 25% (contradicting `no_mesh`) | **Track B first** |
| Nothing dominant, GPU busy in everything | the cost is translation or the GPU itself: Phase 2 |

### Phase 2: Xcode, MoltenVK drop-in, per-pass GPU timing (needs Xcode, your call)
1. **Install Xcode** (see §9; disk is tight). It unlocks: Metal frame capture with per-pass GPU
   time and shader cost, building MoltenVK from source, `xctrace` Metal System Trace.
2. **Build the fork as-is** (`metal4/1.4.2-ryujinx.6`, MSL route, Apache-2.0, local use only):
   `./fetchDependencies --macos` then the macOS dylib target. Verify with `vulkaninfo` that
   `VK_EXT_mesh_shader` appears with `meshShader` true and `taskShader` false.
3. **Experiment E**: swap only `libMoltenVK.dylib` into a copy of the app and run the baseline.
   Lichii ignores mesh (needs both bits), so this isolates "newer MoltenVK with the Metal 4
   command backend" with zero Lichii changes. Gate: ≥ 8% → keep it.
4. **GPU frame capture** of one slow frame (`MTL_CAPTURE_ENABLED=1`, `.gputrace` in Xcode): which
   encoders and pipelines cost most. This settles "is it translation?" with data. If one stage
   (say MoltenVK's emulated tessellation or argument buffer indirection) dominates, patch MoltenVK
   for it before considering Option A.

### Phase 3: Track B, mesh shaders on Metal (3–5 days; run after Gate 1 says so)
Work breakdown, in order. Each step is shippable and keeps the compute fallback as the safety net:

| Step | Change | Files |
|---|---|---|
| B1 | Accept `meshShader` without `taskShader`: new `IsExtMeshShaderMeshOnlySupported()`; keep the existing both-bits check for the NVIDIA/AMD path | `vulkan_device.h/.cpp` |
| B2 | **Mesh-only programs** (no task stage): build a native mesh pipeline through the existing `VK_SHADER_STAGE_MESH_BIT_EXT` path instead of the compute fallback | `vk_pipeline_cache.cpp`, `vk_graphics_pipeline.cpp`, `vk_rasterizer.cpp` |
| B3 | **Limit check per pipeline** against the fork's reported limits (≤ 124 output scalars, ≤ 30208 B). Over the limit → compute fallback for that pipeline. Lichii already logs a "Mesh emulation survey" with vertex lines and max vertices; run it on OoT first to see how many fit | `mesh_fallback_limits.h`, `vk_pipeline_cache.cpp` |
| B4 | **Task + mesh hybrid**: keep the task program as a compute dispatch (it writes payload, offsets, indirect args), draw the mesh stage natively with `vkCmdDrawMeshTasksIndirectEXT` (supported by the fork; the *Count* variant is not). The mesh program must read the payload from the existing storage buffer instead of `TaskPayloadSharedEXT`. This still costs one compute dispatch per task draw but removes the mesh output buffer round trip | `emit_spirv_mesh.cpp`, `vk_pipeline_cache.cpp` |
| B5 | *Stretch:* real task (Metal "object") shaders, needs MoltenVK work for the `emitMeshTasksEXT` semantics and a `taskShader` feature bit. Only if B4 leaves a measurable cost | MoltenVK fork + Lichii |
| B6 | Correctness: screenshot diff native vs fallback at the same replay frames (mean pixel difference within run-to-run noise, as the fork's authors did), no missing geometry vs fallback | harness |

Gate B: B2 + B4 give ≥ 8% on OoT, or ≥ 2× on a mesh-heavy title. If it is < 8% on OoT, still keep it
if it is not slower, because it removes dropped geometry (ineligible pipelines), but do not
count it toward "OoT playable".

### Phase 4: Track C / D follow-through, then re-gate
Whatever Gate 1 chose, implement the smallest change that moves the number, re-run the replay,
and stop when the Done target is hit or a gate fails twice.

### Phase 5 (only if all of the above leave > 50 ms): native Metal
Entry conditions: capture shows translation overhead ≥ 50% of GPU time **and** MoltenVK-level
patches cannot reach it. If reached, the work is a new `renderer_metal` plus an MSL backend in
`src/shader_recompiler/backend/`, months of work, and I would write a separate design first.

## 6. One-shot protocol (how this is run so it doesn't wander)

1. One change per patch file, numbered after 0005 in `patches/lichii/`. `cores/lichii` is never
   edited ([patches/README.md](patches/README.md) rules).
2. Build into the stable `bin/.build/lichii` dir so ccache keeps it incremental.
3. **Never touch the app in `~/Library/Application Support/Uemulator/emulators/lichii` until an A/B
   win is confirmed.** All tests run from `bin/lichii` copies with an isolated data dir (the
   harness already copies `base/data|config|cache`).
4. Pre-registered thresholds (§5). No "looks faster": medians from the harness only.
5. Each phase ends by saving a short results table to `docs/perf/` and committing the patch;
   the next phase starts from a clean baseline.
6. Roll back by dropping the patch or the swapped dylib. Nothing here is irreversible.

## 7. Risks

- **The bottleneck may not be fixable on this GPU/driver stack.** The M5 base GPU is a 10-core
  part and OoT's slow phase may simply be heavy. Phase 2 capture settles this.
- **The fork is a moving target** (Metal 4 command backend, local SPIRV-Cross patches, private Mesa
  for the IR route). Pin a commit; we use only the MSL route.
- **Mesh limits on Metal** (124 scalars, 30 KB) can reject some Switch 2 mesh programs; the
  compute fallback must remain.
- **Correctness drift:** the fork notes a clip-space difference between the MSL and IR mesh routes.
  B6 image diffs guard this.
- **`.nup` Switch 2 support is moving fast upstream.** Rebasing patches onto new Lichii builds will
  be needed; keep patches small.

## 8. My estimates (judgment, not measurements)

- Native mesh path alone (Track B) takes OoT to ≥ 20 fps: **< 5%**.
- Phase 1 finds a lever worth ≥ 25% somewhere in Lichii's own code: **~40%**.
- OoT reaches ≥ 20 fps on this M5 by some route in this effort: **~25–30%**.
- OoT reaches 30 fps: **~10%**.
- Mesh shaders working natively for other Switch 2 titles: **~65%** (existing fork + SPIRV-Cross).

## 9. Decisions I need from you

1. **Xcode.** Only Command Line Tools are installed (no `metal`, no `xctrace`, no `xcodebuild`).
   Phase 2 and Track B both need it. This Mac has **38 GB free (92% full)**; Xcode with its
   components can need a large part of that, so free space first or install the minimum components.
   Phases 0–1 do not need it and can start now.
2. **Permission to build third-party MoltenVK source** (Apache-2.0) for local testing only. It will
   not be redistributed with Uemulator.
3. **Unattended runs:** the sweeps launch Lichii for ~3.5 minutes each, repeatedly, and take over
   the screen. Tell me when it is safe.

## 10. Sources

- [MoltenVK issue #2375: VK_EXT_mesh_shader, further plans](https://github.com/KhronosGroup/MoltenVK/issues/2375)
- [MoltenVK PR #1845: WIP VK_EXT_mesh_shader](https://github.com/KhronosGroup/MoltenVK/pull/1845)
- [eezouhong/MoltenVK PR #23: VK_EXT_mesh_shader on Metal mesh render pipelines](https://github.com/eezouhong/MoltenVK/pull/23)
- [eezouhong/MoltenVK PR #59: mesh shaders through Metal IR](https://github.com/eezouhong/MoltenVK/pull/59)
- [KosmicKrisp XDC 2025 overview (LunarG)](https://www.lunarg.com/wp-content/uploads/2025/10/XDC-2025-KosmicKrisp-Overview.pdf)
- Lichii: [PR #861](https://github.com/zortos293/Lichii/pull/861), [PR #768](https://github.com/zortos293/Lichii/pull/768), [issue draft](lichii-bug-report-draft.md)
