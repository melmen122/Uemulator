#!/bin/zsh
# usage: replay.sh <label> [ENV=VAL ...]
#
# Replays the recorded OoT play session (oot-session.tas) in the Lichii build under test, in an
# isolated copy of the snapshot, and prints one RESULT line (slow-phase frame times + GPU use).
# Extra ENV=VAL arguments are passed to Lichii (e.g. EDEN_NX2_FORCE_MESH_FALLBACK=1).
#
# Optional environment:
#   BENCH_EXIT=170                      seconds after boot to close Lichii
#   BENCH_CFG="key=value;key2=value2"   overrides for qt-config.ini keys (e.g. "fast_gpu_time=0")
#   BENCH_GAMECFG="key=value;..."       per-game overrides for OoT (the file the real app uses)
#   BENCH_DISABLE_ADDON="<add-on name>" disables one of the game's add-ons (e.g. "Max Resolution (built-in)")
#   BENCH_SAMPLE=1                      also take two 5 s `sample` captures once the slow phase starts
#   BENCH_XCTRACE=6                     also record a 6 s Metal System Trace (Xcode) in the slow phase
#   BENCH_THREADS=140                   per-thread CPU snapshots (`ps -M`) starting 140 s after launch
#   LICHII_APP=/path/to/lichii          binary under test (default bin/lichii)
source "${0:A:h}/env.sh"

label=$1; shift
[ -n "$label" ] || die "usage: replay.sh <label> [ENV=VAL ...]"
[ -d "$BENCH_HOME/base" ] || die "no snapshot; run scripts/bench/snapshot.sh first"
[ -x "$APP" ] || die "Lichii binary not found: $APP"
[ -f "$BENCH_GAME" ] || die "game not found; set BENCH_GAME"
lichii_running && die "another Lichii is running"
cmp -s "$TAS_SOURCE" "$TAS_REAL" || echo "bench: warning: $TAS_REAL differs from $TAS_SOURCE" >&2

RUN=$BENCH_HOME/run
RES=$BENCH_HOME/results
EXIT=${BENCH_EXIT:-170}
rm -rf "$RUN"; mkdir -p "$RUN" "$RES/$label.samples"
cp -R "$BENCH_HOME/base/data" "$RUN/data"
cp -R "$BENCH_HOME/base/config" "$RUN/config"
cp -R "$BENCH_HOME/base/cache" "$RUN/cache"
LOG=$RUN/data/eden/log/eden_log.txt
CFG=$RUN/config/eden/qt-config.ini

if [ -n "$BENCH_CFG" ]; then
  for kv in ${(s:;:)BENCH_CFG}; do
    k=${kv%%=*}; v=${kv#*=}
    sed -i '' -e "s|^${k}\\\\default=true|${k}\\\\default=false|" -e "s|^${k}=.*|${k}=${v}|" "$CFG"
  done
fi

# Per-game overrides, written the way Lichii's per-game config stores them (the file the real app
# reads from ~/.config/eden/custom/<title id>.ini): key\use_global=false, key\default=false, key=value.
if [ -n "$BENCH_GAMECFG" ]; then
  GCFG=$RUN/config/eden/custom/0400486024DEC000.ini
  [ -f "$GCFG" ] || die "no per-game config at $GCFG"
  for kv in ${(s:;:)BENCH_GAMECFG}; do
    K=${kv%%=*} V=${kv#*=} perl -pi -e 's/^\Q$ENV{K}\E\\use_global=true$/$ENV{K}\\use_global=false\n$ENV{K}\\default=false\n$ENV{K}=$ENV{V}/' "$GCFG"
  done
fi

if [ -n "$BENCH_DISABLE_ADDON" ]; then
  $PY -I - "$CFG" "$BENCH_DISABLE_ADDON" <<'PY' || die "could not disable add-on"
import sys
p, name = sys.argv[1], sys.argv[2]
s = open(p).read()
old = "1\\disabled\\size=0"
new = "1\\disabled\\size=1\n1\\disabled\\1\\d\\default=false\n1\\disabled\\1\\d=" + name
assert old in s, "no disabled-add-ons entry to edit"
open(p, "w").write(s.replace(old, new, 1))
PY
fi

rm -f "$RES/$label.gpu.stop"
"${0:A:h}/gpu_poll.sh" "$RES/$label.gpu" &
POLL=$!

if [ "$BENCH_SAMPLE" = 1 ]; then
  ( for i in $(seq 1 600); do
      grep -q "Nx2Stutter frame=19[5-9][0-9]" "$LOG" 2>/dev/null && break; sleep 1
    done
    for n in 1 2; do
      P=$(pgrep -f "lichii.app/Contents/MacOS/lichii" | head -1); [ -z "$P" ] && break
      sample "$P" 5 -file "$RES/$label.samples/slow_$n.txt" >/dev/null 2>&1; sleep 10
    done ) &
  SAMPLER=$!
fi

if [ -n "$BENCH_XCTRACE" ]; then
  # Metal System Trace of BENCH_XCTRACE seconds, attached 10 s after the slow phase starts.
  ( for i in $(seq 1 600); do
      grep -q "Nx2Stutter frame=19[5-9][0-9]" "$LOG" 2>/dev/null && break; sleep 1
    done
    sleep 10
    P=$(pgrep -f "lichii.app/Contents/MacOS/lichii" | head -1)
    [ -n "$P" ] && xcrun xctrace record --template "Metal System Trace" --attach "$P" \
      --time-limit "${BENCH_XCTRACE}s" --output "$RES/$label.trace" --no-prompt >"$RES/$label.xctrace.log" 2>&1 ) &
  TRACER=$!
fi

if [ -n "$BENCH_THREADS" ]; then
  # Three `ps -M` per-thread CPU snapshots (5 s apart), the first BENCH_THREADS seconds after launch.
  ( sleep "$BENCH_THREADS"
    for n in 1 2 3; do
      P=$(pgrep -f "lichii.app/Contents/MacOS/lichii" | head -1)
      [ -n "$P" ] && { echo "== snapshot $n (pid $P)"; ps -M -p "$P"; } >> "$RES/$label.threads"
      sleep 5
    done ) &
  THREADER=$!
fi

LAUNCH=$(date +%s)
env XDG_DATA_HOME="$RUN/data" XDG_CONFIG_HOME="$RUN/config" XDG_CACHE_HOME="$RUN/cache" \
    EDEN_TAS_AUTOSTART=3000 EDEN_BENCH_EXIT_SECONDS=$EXIT EDEN_NX2_STUTTER_TRACE=1 EDEN_NX2_GPU_PROFILE=1 "$@" \
    "$APP" -g "$BENCH_GAME" >"$RES/$label.stdout" 2>"$RES/$label.stderr"

touch "$RES/$label.gpu.stop"; sleep 2; kill $POLL $SAMPLER $TRACER $THREADER 2>/dev/null
cp "$LOG" "$RES/$label.log" 2>/dev/null || die "no log produced (did Lichii start?)"
# Screenshots from EDEN_BENCH_SHOT_SECONDS=<s>[,<s>...] (patch 0007), kept for visual comparison.
# Lichii writes them to the REAL ~/.local/share/eden/screenshots (it ignores XDG_DATA_HOME for that
# folder); the log names each file, so move exactly those into the results folder.
if grep -q 'Screenshot saved to' "$LOG" 2>/dev/null; then
  mkdir -p "$RES/$label.shots"
  grep -o 'Screenshot saved to "[^"]*"' "$LOG" | sed -E 's/^Screenshot saved to "//; s/"$//' | while read -r f; do
    f=${f/#\/Users\/user\//$HOME/}
    [ -f "$f" ] && mv "$f" "$RES/$label.shots/"
  done
fi
$PY -I "${0:A:h}/summarize.py" "$RES/$label.log" "$label" "$RES/$label.gpu" "$LAUNCH" | tee "$RES/$label.result"
