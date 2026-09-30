#!/bin/sh
# S3b rerun of the plain-stream baselines after the frame-size fix.
set -u
cd "$(dirname "$0")"
for m in base bigbuf; do
  ./s3b.sh "$m-throughput" 0 0 --mode $m --tests throughput --mib 256
  ./s3b.sh "$m-stall60" 0 0 --mode $m --tests stall --stall 60
done
