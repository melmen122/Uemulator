"""Summarize one replay: frame times of the slow phase, plus GPU utilization in that phase.

usage: summarize.py <eden_log.txt> <label> [<gpu_poll_file> <launch_epoch>]

The slow phase is every frame >= 1950 in the replay (the intro before it runs at 60 fps). The
Lichii build must log "Nx2Stutter frame=N ms=X" lines (EDEN_NX2_STUTTER_TRACE=1), which only
frames slower than ~33 ms produce.
"""
import re
import statistics
import sys

SLOW_FROM_FRAME = 1950

log, label = sys.argv[1], sys.argv[2]
gpu_file = sys.argv[3] if len(sys.argv) > 3 else None
launch_epoch = int(sys.argv[4]) if len(sys.argv) > 4 else None

frames = {}  # frame -> (ms, log timestamp)
last_frame = 0
for line in open(log, errors="replace"):
    m = re.match(r"^\[ *([0-9.]+)\]", line)
    ts = float(m.group(1)) if m else None
    if "Nx2Stutter frame=" in line and "Detail" not in line:
        f = re.search(r"frame=(\d+) ms=([0-9.]+)", line)
        if f:
            n = int(f.group(1))
            frames[n] = (float(f.group(2)), ts)
            last_frame = max(last_frame, n)

slow = [(n, v, ts) for n, (v, ts) in frames.items() if n >= SLOW_FROM_FRAME]
ms = [v for _, v, _ in slow]
res = {
    "label": label,
    "last_logged_frame": last_frame,
    "slow_frames_logged": len(ms),
    "slow_mean_ms": round(statistics.mean(ms), 1) if ms else None,
    "slow_median_ms": round(statistics.median(ms), 1) if ms else None,
    "slow_p95_ms": round(sorted(ms)[int(0.95 * len(ms))], 1) if len(ms) > 20 else None,
    "slow_max_ms": round(max(ms), 1) if ms else None,
}
res["slow_fps"] = round(1000 / res["slow_mean_ms"], 1) if res["slow_mean_ms"] else None

# GPU utilization from the first slow frame on (log time is seconds since Lichii started).
if gpu_file and launch_epoch and slow:
    start = launch_epoch + min(ts for _, _, ts in slow if ts is not None) + 5
    util = {"Device": [], "Renderer": [], "Tiler": []}
    for line in open(gpu_file, errors="replace"):
        parts = line.split()
        if len(parts) < 7 or int(parts[0]) < start:
            continue
        for k, v in zip(parts[1::2], parts[2::2]):
            if k in util:
                util[k].append(int(v))
    for k, vals in util.items():
        res[f"gpu_{k.lower()}_pct"] = round(statistics.mean(vals), 1) if vals else None

print("RESULT", res)
