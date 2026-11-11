#!/bin/zsh
# usage: snapshot.sh [--force]
# Copies the user's Lichii data, config and shader cache into $BENCH_HOME/base. Every replay starts
# from a fresh copy of this snapshot, so the user's real settings and saves are never touched.
# The snapshot holds save data: keep it local (bin/ is gitignored).
source "${0:A:h}/env.sh"

lichii_running && die "Lichii is running. Quit it with Cmd+Q first."
if [ -d "$BENCH_HOME/base" ] && [ "$1" != "--force" ]; then
  die "snapshot exists at $BENCH_HOME/base (use --force to replace it)"
fi

rm -rf "$BENCH_HOME/base"
mkdir -p "$BENCH_HOME/base/data" "$BENCH_HOME/base/config" "$BENCH_HOME/base/cache" "$BENCH_HOME/results"
cp -R ~/.local/share/eden "$BENCH_HOME/base/data/eden"
cp -R ~/.config/eden "$BENCH_HOME/base/config/eden"
cp -R ~/.cache/eden "$BENCH_HOME/base/cache/eden" 2>/dev/null
rm -f "$BENCH_HOME/base/data/eden/log/"*
# This harness' own switch file must not leak into runs; per-run overrides go through the environment.
rm -f "$BENCH_HOME/base/config/eden/nx2_switches.txt"
echo "snapshot: $(du -sh "$BENCH_HOME/base" | cut -f1) in $BENCH_HOME/base"
echo "game: ${BENCH_GAME:-NOT FOUND (set BENCH_GAME)}"
[ -f "$BENCH_HOME/base/data/eden/tas/script0-1.txt" ] && echo "tas script: present" || echo "tas script: MISSING"
