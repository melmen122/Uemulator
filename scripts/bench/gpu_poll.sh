#!/bin/zsh
# usage: gpu_poll.sh <outfile>
# Appends "<epoch> Device N Renderer N Tiler N" once a second until <outfile>.stop appears.
# The numbers are the Apple GPU's own utilization counters (same source as the earlier sweeps).
out=$1; : > "$out"
while [ ! -e "$out.stop" ]; do
  v=$(ioreg -r -d 1 -w0 -c AGXAccelerator 2>/dev/null | grep -oE '"(Device|Renderer|Tiler) Utilization %"=[0-9]+' | sed -E 's/"//g; s/ Utilization %//; s/=/ /' | tr '\n' ' ')
  echo "$(date +%s) $v" >> "$out"; sleep 1
done
