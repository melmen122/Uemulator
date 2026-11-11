#!/bin/zsh
# usage: oot-fast-profile.sh on [half|three-quarter] | off | status
#
# Turns Lichii's "fast" profile on or off for Ocarina of Time (Switch 2) only, in its per-game config
# (~/.config/eden/custom/0400486024DEC000.ini). Other games and the global settings are untouched.
#
#   on   "Ocarina of Time anti-aliasing" = No sharpening (skips the game's upscale network, the main
#        GPU cost on Apple GPUs) + resolution x0.5 (default `half`) or x0.75 (`three-quarter`).
#        Measured in the replay benchmark (docs/perf, plan-metal-gpu.md): 7 fps -> 23-28 fps (half),
#        ~21 fps (three-quarter). The image is cleaner but a bit aliased/softer.
#   off  Back to the global settings (use_global=true) for those two keys.
#
# `on` makes a one-time backup next to the file and refuses to run while Lichii is open (Lichii
# rewrites its config on exit and would overwrite the change).
# Set OOT_CFG=/path/to/file.ini to work on another copy (used for testing).
CFG=${OOT_CFG:-$HOME/.config/eden/custom/0400486024DEC000.ini}
mode=$1 res=${2:-half}

[ -f "$CFG" ] || { echo "no per-game config at $CFG (start the game in Lichii once first)"; exit 1; }

setkey() {  # setkey <key> <value>: per-game override, the way Lichii writes it
  K=$1 V=$2 perl -0pi -e '
    my ($k, $v) = ($ENV{K}, $ENV{V});
    s/^\Q$k\E\\use_global=(?:true|false)\n(?:\Q$k\E\\default=[^\n]*\n)?(?:\Q$k\E=[^\n]*\n)?/$k\\use_global=false\n$k\\default=false\n$k=$v\n/m
      or die "key $k not found in the [Renderer] section\n";
  ' "$CFG"
}
unsetkey() {  # unsetkey <key>: back to the global value
  K=$1 perl -0pi -e '
    my $k = $ENV{K};
    s/^\Q$k\E\\use_global=(?:true|false)\n(?:\Q$k\E\\default=[^\n]*\n)?(?:\Q$k\E=[^\n]*\n)?/$k\\use_global=true\n/m
      or die "key $k not found in the [Renderer] section\n";
  ' "$CFG"
}
show() { grep -E '^(oot_anti_aliasing|resolution_setup)\b' "$CFG"; }

case $mode in
  status) show ;;
  on|off)
    pgrep -f "lichii.app/Contents/MacOS/lichii" >/dev/null && { echo "Lichii is running: quit it (Cmd+Q) first."; exit 1; }
    if [ $mode = on ]; then
      case $res in half) scale=1 ;; three-quarter) scale=2 ;; *) echo "resolution must be half or three-quarter"; exit 1 ;; esac
      bak="$CFG.bak-before-oot-fast-profile"
      [ -e "$bak" ] || cp -p "$CFG" "$bak" && echo "backup: $bak"
      setkey oot_anti_aliasing 1 && setkey resolution_setup $scale || exit 1
    else
      unsetkey oot_anti_aliasing && unsetkey resolution_setup || exit 1
    fi
    show ;;
  *) echo "usage: $0 on [half|three-quarter] | off | status"; exit 1 ;;
esac
