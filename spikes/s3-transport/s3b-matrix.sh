#!/bin/sh
# S3b matrix: output candidates (throughput, 60 s stall, silent peer death) and the input window.
set -u
cd "$(dirname "$0")"
r() { ./s3b.sh "$@"; }
for m in base bigbuf credit credit-noack; do
  noack=0; [ "$m" = credit-noack ] && noack=1
  r "$m-throughput" 0 $noack --mode $m --tests throughput --mib 256
  r "$m-stall60" 0 $noack --mode $m --tests stall --stall 60
done
r credit-deadpeer 0 0 --mode credit --tests deadpeer --stall 60
r credit-noack-deadpeer 0 1 --mode credit-noack --tests deadpeer --stall 60
for d in 1 3; do
  r "credit-noack-throughput-d$d" $d 1 --mode credit-noack --tests throughput --mib 256
  r "credit-noack-w32-throughput-d$d" $d 1 --mode credit-noack --tests throughput --mib 256 --window 32
  r "credit-throughput-d$d" $d 0 --mode credit --tests throughput --mib 256
done
for d in 0 1 3; do
  for kib in 256 1024 4096; do r "input-1x${kib}K-d$d" $d 0 --mode credit --tests input --input-kib $kib --inflight 1; done
  r "input-4x256K-d$d" $d 0 --mode credit --tests input --input-kib 256 --inflight 4
done
