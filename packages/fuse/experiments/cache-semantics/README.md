# FUSE-T cache-semantics experiment harness

Reproducible apparatus behind the results in
[`../../CACHE_SEMANTICS_VERIFICATION.md`](../../CACHE_SEMANTICS_VERIFICATION.md).
It isolates the **macOS NFS client ↔ FUSE-T** caching layer (the load-bearing
claims in PR #4642) with a synthetic filesystem we fully control, instead of the
whole CF backend.

- `synthfs.c` — high-level libfuse filesystem. `/dir/pre` always exists;
  `/dir/target` begins to exist at a shared absolute epoch (daemon-side, no
  client syscalls). Logs every kernel op with an epoch-ms timestamp. Env:
  `APPEAR_EPOCH_MS` (absolute appear time), `BUMP_MTIME=1` (bump `/dir` mtime
  when target appears; default: constant mtime, modelling CF's timestamp-less
  stats), `APPEAR_AT` (seconds fallback).
- `driver.py` — stat/readdir sequences (`arm_a`…`arm_f`) on the same clock.
- `run_arm.sh MODE LEAD_S BUMP_MTIME` — fresh mount per run, correlates driver
  events with the daemon log. `MOPTS="-o noattrcache"` toggles the mount option.

## Build

```bash
INC="/Library/Application Support/fuse-t/include/fuse"
cc -D_FILE_OFFSET_BITS=64 -DFUSE_USE_VERSION=26 synthfs.c \
   -I"$INC" -L/usr/local/lib -Wl,-rpath,/usr/local/lib -lfuse-t -o synthfs
```

## Run

```bash
./run_arm.sh arm_a 8 0                 # ~50s negative-cache stale window
./run_arm.sh arm_b 8 0                 # a readdir collapses it
GAP=0.5 ./run_arm.sh arm_f 2 0         # E4 false-negative (intermittent)
GAP=0.5 ./run_arm.sh arm_f 2 1         # bumped mtime — still fails
MOPTS="-o noattrcache" ./run_arm.sh arm_a 8 0   # window → 0.25s
```

Requires FUSE-T (`brew install fuse-t`); verified against FUSE-T 1.0.49 on macOS
15 / arm64.
