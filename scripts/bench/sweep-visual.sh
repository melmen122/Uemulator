#!/bin/zsh
# usage: sweep-visual.sh
# Needs a build with patches 0006 + 0007. Five runs (~5 min each), each with screenshots at 150 s and
# 165 s after boot. The TAS replay (2272 input frames) is over well before that in every
# configuration, so the character idles in the same scene and the screenshots compare directly.
#   v_base           game default (Game anti-aliasing, x1): regression check + the "before" image
#   v_bypass100      No sharpening, x1
#   v_bypass075      No sharpening, x0.75
#   v_bypass050      No sharpening, x0.5 (patch 0006 active: the heavy dispatch is skipped)
#   v_bypass050_keep No sharpening, x0.5, EDEN_NX2_OOT_KEEP_HEAVY=1 (heavy dispatch kept): isolates 0006
source "${0:A:h}/env.sh"
SHOTS=EDEN_BENCH_SHOT_SECONDS=150,165

run() {  # run <label> [ENV=VAL ...]
  label=$1; shift
  echo "=== $label"; "$BENCH_DIR/replay.sh" "$label" "$SHOTS" "$@" 2>&1 | grep -E "RESULT|bench:"
}

run v_base
BENCH_CFG="oot_anti_aliasing=1" run v_bypass100
BENCH_CFG="oot_anti_aliasing=1;resolution_setup=2" run v_bypass075
BENCH_CFG="oot_anti_aliasing=1;resolution_setup=1" run v_bypass050
BENCH_CFG="oot_anti_aliasing=1;resolution_setup=1" run v_bypass050_keep EDEN_NX2_OOT_KEEP_HEAVY=1
echo "SWEEP-VISUAL DONE"
