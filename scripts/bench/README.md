# scripts/bench: Lichii replay benchmark

Measures how fast Lichii renders the slow gameplay phase of Ocarina of Time (Switch 2) on this Mac,
by replaying a recorded play session. Used by `plan-metal-gpu.md`. The old copy of this harness lived
in a session temp folder and was lost to an OS update, so it now lives in the repo.

| File | What it does |
|---|---|
| `snapshot.sh` | Copies your Lichii data/config/cache into `bin/.bench/base`. Run once, and again if your saves change. Quit Lichii first. |
| `replay.sh <label> [ENV=VAL ...]` | One ~3.5 min run on a fresh copy of the snapshot. Prints a `RESULT` line. Results land in `bin/.bench/results/<label>.*`. |
| `sweep-level1.sh [repeats]` | Max Resolution off / GPU Clocks Normal / both, `repeats` runs each. |
| `sweep-stack.sh`, `sweep-network.sh`, `sweep-bypass-res.sh`, `sweep-visual.sh` | The later experiments (Max Resolution off + resolution/no-mesh, the OoT "No sharpening" network bypass, bypass + resolution, and the screenshot/patch-0006 sweep). `sweep-visual.sh` needs a build with patch 0007. |
| `replay.sh` options | `BENCH_XCTRACE=6` records a Metal System Trace (Xcode) of the slow phase; `BENCH_GAMECFG="k=v;..."` writes per-game overrides; `EDEN_BENCH_SHOT_SECONDS=150,165` (patch 0007) saves screenshots to `results/<label>.shots/`. |
| `summarize.py`, `gpu_poll.sh` | Frame-time summary and GPU utilization sampler used by `replay.sh`. |
| `oot-session.tas` | The recorded inputs (same as `~/.local/share/eden/tas/script0-1.txt`, where Lichii reads them). |
| `env.sh` | Paths and overrides (`BENCH_HOME`, `LICHII_APP`, `BENCH_GAME`). |

Your real Lichii settings and saves are never modified: every run uses a copy under `bin/.bench/run`
via `XDG_*_HOME`. The snapshot contains save data, so it stays in `bin/` (gitignored).

**Reading a result.** `slow_median_ms` is the number to compare. Run-to-run noise is about +-4%, so a
change counts only if it beats baseline by 8% or more in two runs. `gpu_*_pct` are the Apple GPU's
own Device / Renderer / Tiler utilization over the slow phase.

**Caveat.** The replay assumes the save state the recording was made from. If the replay does not
reach the slow phase (few `slow_frames_logged`, `last_logged_frame` < 1950), re-record or re-snapshot.
