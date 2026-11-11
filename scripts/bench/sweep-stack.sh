#!/bin/zsh
# usage: sweep-stack.sh
# Stacks experiments on top of the best setting found by sweep-level1.sh ("Max Resolution
# (built-in)" off). About 5 minutes per run, 4 runs:
#   maxres_off_2        pure confirmation of the maxres_off win
#   maxres_off_half     + host resolution x0.5 (resolution_setup=1)
#   maxres_off_quarter  + host resolution x0.25 (resolution_setup=0)
#   maxres_off_nomesh   + every mesh draw skipped (EDEN_NX2_NO_MESH=1): upper bound for mesh shaders
source "${0:A:h}/env.sh"

run() {  # run <label> [ENV=VAL ...]
  label=$1; shift
  echo "=== $label"; "$BENCH_DIR/replay.sh" "$label" "$@" 2>&1 | grep -E "RESULT|bench:"
}

export BENCH_DISABLE_ADDON="Max Resolution (built-in)"
run maxres_off_2
BENCH_CFG="resolution_setup=1" run maxres_off_half
BENCH_CFG="resolution_setup=0" run maxres_off_quarter
run maxres_off_nomesh EDEN_NX2_NO_MESH=1
echo "SWEEP-STACK DONE"
