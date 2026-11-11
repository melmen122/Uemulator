#!/bin/zsh
# usage: sweep-level1.sh [repeats]
# Plan phase 0, step 3: the unfinished "let the game draw less" experiment. Each variant runs
# `repeats` times (default 2; run-to-run noise is about +-4%). About 3.5 minutes per run.
source "${0:A:h}/env.sh"
R=${1:-2}

run() {  # run <label> [ENV=VAL ...]; BENCH_CFG / BENCH_DISABLE_ADDON come from the caller's environment
  label=$1; shift
  for i in $(seq 1 $R); do
    echo "=== $label #$i"; "$BENCH_DIR/replay.sh" "${label}_$i" "$@" 2>&1 | grep -E "RESULT|bench:"
  done
}

BENCH_DISABLE_ADDON="Max Resolution (built-in)" run maxres_off
BENCH_CFG="fast_gpu_time=0" run gpuclock_normal
BENCH_CFG="fast_gpu_time=0" BENCH_DISABLE_ADDON="Max Resolution (built-in)" run maxres_off_gpunormal
echo "SWEEP-LEVEL1 DONE"
