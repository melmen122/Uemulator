#!/bin/zsh
# usage: sweep-bypass-res.sh
# With "No sharpening" (the upscale network skipped) the slow phase is fragment-bound (62% of the
# GPU window in the Metal trace), so host resolution should matter again. resolution_setup:
# 0 = x0.25, 1 = x0.5, 2 = x0.75, 3 = x1 (default).
source "${0:A:h}/env.sh"

run() {  # run <label> [ENV=VAL ...]
  label=$1; shift
  echo "=== $label"; "$BENCH_DIR/replay.sh" "$label" "$@" 2>&1 | grep -E "RESULT|bench:"
}

BENCH_CFG="oot_anti_aliasing=1;resolution_setup=2" run oot_bypass_res075
BENCH_CFG="oot_anti_aliasing=1;resolution_setup=1" run oot_bypass_res050
echo "SWEEP-BYPASS-RES DONE"
