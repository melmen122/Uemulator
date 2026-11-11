#!/bin/zsh
# Shared settings for the Lichii benchmark harness. Source this file; do not run it.
# Everything here can be overridden from the environment.

BENCH_DIR=${0:A:h}
REPO=${BENCH_DIR:h:h}

# Where the isolated data snapshot, per-run scratch dir and results live (inside bin/, gitignored).
BENCH_HOME=${BENCH_HOME:-$REPO/bin/.bench}

# The Lichii build under test. Point this at a patched copy to A/B different builds.
APP=${LICHII_APP:-$REPO/bin/lichii/lichii.app/Contents/MacOS/lichii}

# The game to replay on. The default finds the OoT Switch 2 .nup under ~/Documents/roms_uem.
if [ -z "$BENCH_GAME" ]; then
  BENCH_GAME=$(find "$HOME/Documents/roms_uem" -type f -name "*0400486024DEC000*.nup" 2>/dev/null | head -1)
fi

# The recorded play session. Lichii reads TAS scripts from the real ~/.local/share/eden/tas.
TAS_SOURCE=$BENCH_DIR/oot-session.tas
TAS_REAL=$HOME/.local/share/eden/tas/script0-1.txt

# A Python that does not depend on the Xcode license: /usr/bin/python3 is an Xcode shim that
# refuses to run once Xcode.app exists but its license is not accepted.
if [ -z "$PY" ]; then
  for c in /opt/homebrew/bin/python3 /Library/Developer/CommandLineTools/usr/bin/python3 /usr/bin/python3; do
    [ -x "$c" ] && { PY=$c; break; }
  done
fi

die() { echo "bench: $*" >&2; exit 1; }
lichii_running() { pgrep -f "lichii.app/Contents/MacOS/lichii" >/dev/null; }
