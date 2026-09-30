#!/bin/sh
# S3b rerun: plain-stream baselines (frame-size fix), dead peer, and the delayed rows (relay timer fix).
set -u
cd "$(dirname "$0")"
r() { ./s3b.sh "$@"; }
for m in base bigbuf; do
  r "$m-throughput" 0 0 --mode $m --tests throughput --mib 256
  r "$m-stall60" 0 0 --mode $m --tests stall --stall 60
done
r credit-deadpeer 0 0 --mode credit --tests deadpeer --stall 30
r credit-noack-deadpeer 0 1 --mode credit-noack --tests deadpeer --stall 30
for d in 1 3; do
  r "credit-w8-d$d" $d 0 --mode credit --tests throughput --mib 256
  r "credit-noack-w8-d$d" $d 1 --mode credit-noack --tests throughput --mib 256
  r "credit-noack-w32-d$d" $d 1 --mode credit-noack --tests throughput --mib 256 --window 32
  r "credit-noack-w8-stall60-d$d" $d 1 --mode credit-noack --tests stall --stall 60
  for kib in 256 1024 4096; do r "input-1x${kib}K-d$d" $d 0 --mode credit --tests input --input-kib $kib --inflight 1; done
  r "input-4x256K-d$d" $d 0 --mode credit --tests input --input-kib 256 --inflight 4
done
