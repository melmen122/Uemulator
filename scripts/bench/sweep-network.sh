#!/bin/zsh
# usage: sweep-network.sh
# The Metal System Trace of the slow phase showed ~46% of GPU time in ~60 ms compute jobs, and
# Lichii's docs/nx2/oot-network-bypass.md names the game's upscale "network" chain as the heavy
# compute. "No sharpening" (oot_anti_aliasing=1) skips the prepass and the network.
#   oot_bypass          No sharpening, Max Resolution add-on on (the combination the doc validated)
#   maxres_off_bypass   No sharpening + Max Resolution add-on off
source "${0:A:h}/env.sh"

run() {  # run <label> [ENV=VAL ...]
  label=$1; shift
  echo "=== $label"; "$BENCH_DIR/replay.sh" "$label" "$@" 2>&1 | grep -E "RESULT|bench:"
}

BENCH_CFG="oot_anti_aliasing=1" run oot_bypass
BENCH_CFG="oot_anti_aliasing=1" BENCH_DISABLE_ADDON="Max Resolution (built-in)" run maxres_off_bypass
echo "SWEEP-NETWORK DONE"
