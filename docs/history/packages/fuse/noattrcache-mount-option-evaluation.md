---
status: historical
created: 2026-07-13
archived: 2026-07-14
reason: "Point-in-time record of the evaluation and live-stack measurements behind defaulting FUSE-T mounts to attrcache-timeout=1"
---

# Evaluation: mounting cf FUSE filesystems with FUSE-T's `noattrcache`

This records the evaluation of whether cf fuse mounts on macOS should use
FUSE-T's `-o noattrcache` mount option (or equivalent `actimeo` tuning) by
default, behind a flag, or not at all. The evaluation ran in two stages. The
first stage (2026-07-13, no FUSE-T available on the working machine) decided
on opt-in flags. The second stage (2026-07-14, FUSE-T 1.2.7 installed,
measurements against a live space) revised that: **FUSE-T mounts default to
`attrcache-timeout=1`**, with `--attrcache-timeout 0` restoring untuned
caching and `--noattrcache` kept as a diagnostic dial. The live registry
entry is `docs/development/EXPERIMENTAL_OPTIONS.md`, `fuseNfsCacheTuning`.

## Background

PR #4642 replaced `cf exec`'s mounted-callable stat poll with a single stat
plus a parent-directory-listing fallback and a bounded recheck delay
(`DIR_LISTING_RECHECK_DELAY_MS`, 3.5 s, in `packages/cli/lib/exec.ts`). The
experiments recorded in PR #4654's verification document
(`CACHE_SEMANTICS_VERIFICATION.md` on that branch; FUSE-T 1.0.49, macOS 15,
arm64) established:

- The stale `NotFound` after a daemon-side `ENOENT` is the macOS NFS
  client's negative name cache. On an aged mount it persisted ~50 s, during
  which ~100 stats produced zero daemon traffic.
- Cached parent directory listings are served without a daemon round-trip
  for up to ~3 s, which produced a reproduced false negative in the exec
  fallback (stale listing answered inside its validity window).
- Mounting with `-o noattrcache` shrank the negative-cache window from ~50 s
  to ~0.25 s and eliminated the false negative entirely. Cost: one NFS RPC
  per stat.
- FUSE-T ignores the entry/attribute timeouts the filesystem returns, so the
  bridge cannot tune caching from its side; mount options are the only dial.

## What this evaluation added

### The option plumbing is sound

FUSE-T's open-source client library (`macos-fuse-t/libfuse`,
`lib/mount_darwin.c`) parses `noattrcache` as a mount option
(`FUSE_OPT_KEY("noattrcache", KEY_NOATTRCACHE)`) and forwards it to the
closed-source NFS daemon as `--attrcache=false`. The #4654 harness passed it
through the same `fuse_mount` args vector that `packages/fuse/mod.ts` builds,
so pushing `-o noattrcache` into the args handed to `fuse_mount` is the
correct and empirically validated mechanism.

### There is a middle ground after all

The premise that FUSE-T offers no setting between full caching and
`noattrcache` turned out to be wrong. `lib/mount_darwin.c` also parses
`attrcache-timeout=%d`, forwarded to the daemon as `--attrcache-timeout=N`,
and FUSE-T's v1.0.29 release notes state it "controls nfs mount `actimeo`
parameter". It is absent from the wiki's mount-option list but present in
the current (March 2026) source. `actimeo=N` caps all four attribute-cache
bounds (`acregmin/acregmax/acdirmin/acdirmax`), which also bounds how long a
negative name entry survives behind a cached directory attribute and how
long a cached listing is served. A ~1 s setting would bound the measured
50 s staleness at ~1 s while keeping hot stat loops served from cache — a
much better default candidate than paying one RPC per stat.

### The livelock risk was misattributed, but a CF-specific exposure exists

The livelock concern came from macos-fuse-t/fuse-t#61 (restic on Sonoma:
the NFS client looping endlessly on open/close). Reading the full issue
thread showed the failing configuration had attribute caching at its
default — the livelock was **not** triggered by `noattrcache`. The
maintainer's root cause: restic's Go FUSE library (`anacrolix/fuse`)
returned a fresh inode number for every lookup of the same file; FUSE-T maps
inode numbers 1:1 to NFS file handles, and macOS issues double lookups —
seeing two different handles for the same name sent it into an infinite
relookup loop. The fix landed in `anacrolix/fuse` PR #11 (stable node
identities, November 2024), not in FUSE-T.

That reattribution mostly de-risks `noattrcache`, with one CF-specific
caveat: the cf fuse bridge also does not keep inode numbers stable across
piece-prop rebuilds. `FsTree.clear` drops the subtree's inodes and
rehydration allocates fresh ones (`allocInode` is monotonic; `tree.ts`), so
the same path presents a new NFS file handle after every rebuild. Between
rebuilds handles are stable, so cf is not in the pathological
every-lookup-a-new-handle regime — but a cell rebuilding rapidly while a
client stats the same path could let the double-lookup observe two handles,
the #61 shape. Client-side caching currently absorbs most of those
double-lookups; `noattrcache` removes that absorption. This is the concrete
reason the flag should soak under real agent workloads before becoming a
default, and inode stability across rebuilds is the mitigation to pursue if
the soak ever reproduces looping.

### Upstream has moved since the measurements

- FUSE-T 1.0.39d (August 2024) "Remove NFS `noac` mount options because it
  seems not to be working as expected" — the daemon's internal mechanism for
  `--attrcache=false` was reworked and is not inspectable (closed source).
  The 1.0.49 measurements postdate that rework, so the option demonstrably
  still disables caching effectively, but the exact mount flags used are
  unverifiable.
- Current FUSE-T is 1.2.7 (June 2026). No changelog entry since 1.0.49
  touches attribute caching for the NFS backend.
- FUSE-T 1.1.0+ adds an experimental FSKit backend (`-o backend=fskit`,
  macOS 26+) that bypasses the NFS client entirely; the whole NFS cache
  analysis is NFS-backend-specific.

## Stage-one decision (2026-07-13, superseded)

With no FUSE-T on the working machine (the installer needs an admin
password), the first stage decided: expose both options as opt-in flags and
adopt neither as default, because the exec-level workaround already covered
correctness, every empirical number predated the current FUSE-T and macOS,
and the rebuild-unstable-inode exposure deserved a soak before any default.
The suggested soak: agents hammering a live mounted space under each
setting, comparing overhead and watching for lookup loops.

## Stage two: measurements on the live stack (2026-07-14)

FUSE-T 1.2.7 was installed (system-wide, via Homebrew) and the soak ran
against a real space on the local toolshed: a deployed counter piece, writes
driven exclusively through the cf CLI (never through the mount), and probes
(stat, open/read, readdir) through fresh mounts per setting. macOS 26.5,
arm64. Key findings:

- **The 1.2.7 option semantics differ from the 1.0.49-era analysis.**
  `nfsstat -m` shows `-o noattrcache` mounts with only `nonegnamecache`
  (negative name lookups uncached; positive attribute caching keeps the
  5-60 s defaults), and `-o attrcache-timeout=1` mounts with every
  attribute-cache bound fixed at 1 s (`acregmin=1 ... acrootdirmax=1`),
  negative name cache retained.
- **The original problem reproduces exactly on the real stack.** Untuned
  mounts served a stale `NotFound` for 56.3 s in one run and 3.2 s in
  another (the age-based 5-60 s lottery); listing staleness ranged
  0.8-53.4 s. Daemon-side instrumentation (`CF_FUSE_DEBUG`) showed the
  bridge applied the CLI write within ~150 ms in every case — all remaining
  latency was client-side cache staleness.
- **`noattrcache` no longer fixes it.** Windows of 7.5 s and 29.3 s
  remained (the directory attribute cache still serves the old listing);
  only the negative-entry pinning is gone. The #4654-era claim of one RPC
  per stat is also gone: stats cost ~2 microseconds, cache-served.
- **`attrcache-timeout=1` fixes it.** Stale-`NotFound` windows of 0.18 s
  and 0.42 s; listing staleness 0.8 s; stats ~1.7 microseconds.
- **No livelock under rebuild storms in any setting.** 60 s storms
  (~3 writes/s driving piece-prop rebuilds, two 20 Hz read loops): zero
  read errors under `attrcache-timeout=1`; a handful of sub-110 ms honest
  ENOENT transients elsewhere; go-nfsv4 CPU at most 3%.
- **5-minute endurance under `attrcache-timeout=1`:** 1296 daemon-side
  writes, ~2790 probes per target (open/read on two files, readdir, plus a
  stat of a permanently absent name), p50 1.03 ms / p99 4.01 ms / max
  28.5 ms, four ENOENT blips with worst streak 110 ms while a rebuilt file
  reappeared, zero false "exists" answers for the absent name, no hangs.

| Measured on the live stack | untuned | `--noattrcache` | `--attrcache-timeout 1` |
| --- | --- | --- | --- |
| Stale-`NotFound` window | 3.2 s / 56.3 s | 7.5 s / 29.3 s | 0.18 s / 0.42 s |
| Listing staleness | 0.8 s / 53.4 s | 26.7 s | 0.8 s |
| Stat cost (hot loop) | 1.9 us | 2.0 us | 1.7 us |
| Storm read errors (60 s) | 3 blips ≤60 ms | 1 blip ≤60 ms | 0 |
| Livelock / daemon CPU | none / 3% | none / 3% | none / 3% |

## Final decision

FUSE-T mounts default to `attrcache-timeout=1`. `--attrcache-timeout 0`
restores the NFS client's untuned caching, `--attrcache-timeout <n>` picks a
different bound, and `--noattrcache` remains available as a diagnostic dial.
The default applies only when the loaded provider is FUSE-T — macFUSE
rejects unknown mount options, and Linux ignores the flags. FUSE-T versions
older than 1.0.29 (October 2023) predate the `attrcache-timeout` option and
need `--attrcache-timeout 0`.

## What was implemented alongside this evaluation

- `cf fuse mount --noattrcache` and `--attrcache-timeout <seconds>`
  (mutually exclusive), plumbed through the foreground command, the
  background supervisor, and the compiled binary's hidden subcommands to
  `fuse_mount` via `buildMountFuseArgs` in
  `packages/fuse/mount-options.ts`, with the FUSE-T default of 1 second
  applied there, gated on the loaded provider.
- Probing of FUSE-T's per-user install location
  (`~/.fuse-t/usr/local/lib`) in `packages/fuse/platform-darwin.ts`.
- Registry entry `fuseNfsCacheTuning` in
  `docs/development/EXPERIMENTAL_OPTIONS.md`; user-facing docs in
  `packages/fuse/README.md`; a staleness note in the fuse-workflow skill.
- The `DIR_LISTING_RECHECK_DELAY_MS` recheck in `packages/cli/lib/exec.ts`
  is unchanged: it still covers untuned, macFUSE, and old-FUSE-T mounts,
  and mounts on the new default stop hitting the miss path it guards.
  Shrinking it toward the one-second bound is a follow-up once the default
  has field-soaked.
