# FUSE cache semantics: verifying the claims in PR #4642

Status: live working document. Source-verified claims are marked; the
experiments below were **executed on macOS 15 (Darwin 24.6.0, arm64) against
FUSE-T 1.0.49** on 2026-07-10 and their results are recorded inline. When PR
#4642 is resolved, archive this file to `docs/history/packages/fuse/` per
`docs/README.md`.

## TL;DR of the executed experiments

Measured against a purpose-built synthetic FUSE-T filesystem (high-level
libfuse, full daemon-side control; see "Experimental apparatus"):

1. **Claim 2 CONFIRMED.** The stale `NotFound` is the macOS NFS client's
   **negative name cache**. A single daemon-side `ENOENT` seeds it; on an aged
   mount it persisted **~50 s** (bounded by `acdirmax`≈60 s), during which ~100
   stats produced **zero** daemon traffic. The old 20×50 ms = 1 s poll never had
   a chance.
2. **Claim 3 CONFIRMED — with a caveat.** A `readdir` that _reaches the daemon_
   uses READDIRPLUS, refreshes attributes, and collapses the window to ~0; an
   interleaved/preceding readdir keeps the negative entry from ever persisting.
   So the PR's fallback normally works.
3. **NEW — the residual false-negative (E4) is REAL and reproduced.** When the
   fallback `readdir` fires while a cached parent _listing_ is still inside the
   directory attribute-cache validity window (≈<3 s since that dir was last
   listed) **and** a negative name entry is live **and** the file just appeared,
   the readdir is served the **stale cached listing with no daemon round-trip**,
   so the PR returns a false "not found" with **zero retries** while the file
   exists. Reproduced repeatedly (timing-narrow but reachable).
4. **The bump-mtime idea this doc originally proposed does NOT reliably fix
   it.** Within the validity window the client serves the cached listing
   _without revalidating the directory_, so it never issues the getattr that
   would reveal a bumped mtime. Directly observed a false-negative under bumped
   mtime with zero post-appear dir getattrs.
5. **`-o noattrcache` DOES fix both.** Stale window 50 s → 0.25 s; the E4 race
   disappears (every stat reaches the daemon). Cost: one RPC per stat.
6. **The window is age-dependent.** Young mount → short (near `acdirmin`≈5 s);
   aged → up to `acdirmax`≈60 s. Explains field variability.

Recommendation shift: the robust _code-level_ fix is a **single bounded retry on
the readdir-fallback-miss path** (sleep ~1–2 s to cross the validity window,
then readdir once more) — latency lands only on the miss path, and a genuinely
absent file still fails after one retry. Removing _all_ retries is what creates
the zero-retry false-negative. `-o noattrcache` is the systemic alternative.

## Context

[PR #4642](https://github.com/commontoolsinc/labs/pull/4642) replaces the
20×50ms `Deno.stat` poll in `cf exec`'s mounted-callable existence check
(`packages/cli/lib/exec.ts`) with a single stat plus a parent-directory-listing
fallback. Its justification makes several claims about "FUSE semantics". Those
claims mix behavior from four distinct layers, and only some layers exist on
each platform. This document attributes each claim to its layer, records what is
already verified against primary sources, and specifies the experiments needed
to confirm the rest.

## Layer map

CF FUSE runs on both Linux and macOS, but the cache stack differs completely:

| Layer                                | Platform   | What it caches / controls                                                                                                                                                                                                                                                                                                                                                                                                                      | Can CF control it?                     |
| ------------------------------------ | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| **CF fuse bridge** (`packages/fuse`) | both       | In-memory `FsTree`; clears + re-hydrates piece-prop subtrees on cell changes; hydrates on both lookup (`cell-bridge.ts` `prepareLookup`) and readdir (`prepareDirectory`); maps _any_ hydration failure to ENOENT (`mod.ts:1000-1002`)                                                                                                                                                                                                         | yes — it's ours                        |
| **Kernel FUSE via libfuse**          | Linux only | Honors `entry_timeout`/`attr_timeout` per reply (CF sends 0 for dynamic inodes, `mod.ts:920`); does **not** cache negative lookups when the fs replies `fuse_reply_err(ENOENT)` (negative dentry caching requires replying an entry with `ino=0` and a timeout); does not cache readdir by default; supports `notify_inval_entry`/`notify_inval_inode`                                                                                         | yes — via reply timeouts and notify    |
| **FUSE-T translation**               | macOS only | Userspace NFS server bridging libfuse to the macOS NFS client. Wiki, verbatim: "Caching of attributes is done by the client. Currently the caching attributes returned by the filesystem implementation are ignored" and "Notifications: Works for SMB backend, unsupported for NFS and FSKit". Closed-source binary; offers a `-noattrcache` mount option                                                                                     | only via mount options                 |
| **macOS NFS client** (xnu)           | macOS only | Attribute cache 5s min / 60s max by default (`acregmin`/`acdirmin`, `mount_nfs(8)`); **negative name cache on by default** (`nonegnamecache` exists to disable); lookup trusts a negative entry behind a _cached_ directory GETATTR (`nfs_vnop_lookup`, `NGA_CACHED`); a readdir starting at offset 0 forces an _uncached_ directory GETATTR (`nfs_vnop_readdir`, `NGA_UNCACHED`) and purges caches only if the directory's attributes changed | no — kernel policy; only mount options |

Consequences of the layer map:

- CF's zero entry/attr timeouts (`mod.ts:910-920`) are fully effective on Linux
  and a **documented no-op on macOS** — FUSE-T ignores them.
- The entire "stale NotFound" phenomenon PR #4642 addresses **cannot occur on
  Linux** from kernel caching: with timeout 0 and error-style ENOENT replies,
  every `stat` reaches the bridge. On Linux, a stale NotFound can only be a
  bridge answer (see the hydration-failure catch below).
- The PR's fallback readdir is, on Linux, simply a second trip to the bridge
  (readdir is never kernel-cached by default) — redundant but harmless, and it
  effectively grants one bridge-side retry via `prepareDirectory`.

## Claim-by-claim status

Layer key: **B** = CF bridge, **K** = Linux kernel FUSE, **T** = FUSE-T, **N** =
macOS NFS client.

### 1. "FUSE-T cannot push kernel cache invalidations" — CONFIRMED (T; macOS only)

FUSE-T wiki lists notifications as unsupported for the NFS backend (CF uses NFS;
`mod.ts:3195` passes only `allow_other`/`default_permissions`). Matches the
ENOSYS handling at `mod.ts:3273`/`3307`. On Linux this claim is false —
`notify_inval_*` works — but there it is also unnecessary given timeout 0.

### 2. "A stale FUSE-T kernel cache reports transient NotFound" — MECHANISM IDENTIFIED, SEED UNCONFIRMED (N seeded by B; macOS only)

The sustaining mechanism is the macOS NFS client's **negative name cache**: once
a lookup has been answered ENOENT, xnu's `nfs_vnop_lookup` keeps returning
ENOENT from cache, with no network round-trip, until a _directory change_ is
detected — potentially far longer than the old 1s poll budget (which explains
"an invalidation window that outlasted the budget").

But a negative entry must be **seeded** by one genuine ENOENT crossing the wire.
The bridge hydrates before answering lookups, so the prime suspect is
`mod.ts:1000-1002`: any transient `prepareLookup` failure is swallowed into
`fuse_reply_err(ENOENT)`. One transient hydration error → one ENOENT → the
kernel repeats it for the whole window. Unconfirmed; Experiment E1.

Platform note: on Linux the same hydration-failure ENOENT is _not_ cached, so
the next stat retries the bridge — which is why the old poll "worked" and why
the phenomenon is macOS-only in practice.

### 3. "A readdir goes back to the bridge, so the listing names every callable file that exists" — PARTLY CONFIRMED (N; macOS only; trivially true on Linux)

Verified in xnu: a readdir from offset 0 (every `Deno.readDir`) always sends an
**uncached** GETATTR for the directory to the server — the exact asymmetry vs.
lookup that makes the PR's fallback work. Not guaranteed: the _entries_ are
re-fetched only if that GETATTR shows the directory changed. CF's
`buildNodeStat` (`stat.ts:59`) sends **no timestamps**, so change detection may
never fire, and a previously kernel-cached listing may be served without
reaching the bridge.

Why the fallback still works for the PR's target race: any cached listing either
predates the subtree clear (file existed → named) or was answered by the bridge
post-hydration (→ named). Residual false-negative: a **just-created** callable
whose parent listing was kernel-cached before it existed now fails with zero
retries. Experiments E4/E5.

### 4. "Listing type flags come from the same cached attribute channel; name match counts unless the entry is a directory" — PLAUSIBLE, UNVERIFIED (N; macOS only; low stakes)

Consistent with NFS READDIRPLUS semantics. The directionally safe guard in the
PR is reasonable. Not worth an experiment unless E4 shows anomalies.

### 5. "A Deno.watchFs-based wait would never fire" — CONFIRMED ON BOTH PLATFORMS, for different reasons

macOS: FSEvents cannot observe daemon-side changes on an NFS volume, and FUSE-T
notifications are unsupported on NFS. Linux: inotify on FUSE only reports
changes that pass through the kernel; bridge-side rehydration does not. (See
libfuse wiki "Fsnotify and FUSE".) The PR's secondary argument — an event-driven
wait cannot terminate for a genuinely absent file without a deadline — holds
regardless of platform.

## What we still do not understand (post-experiment)

Mostly resolved. Remaining open items:

1. **Real-stack cross-check.** All results are from the synthetic fs. Worth a
   confirmation run against a real CF mount (E1: does the bridge hydration-catch
   at `mod.ts:1000-1002` fire during an input-write race?) — but arm_a already
   shows the seed source doesn't change the outcome.
2. **Exact validity-window boundary.** Observed ~2.6 s "served stale" vs ~3.1 s
   "revalidated"; the macOS attr cache is age-based (`acdirmin`..`acdirmax`), so
   the boundary drifts with mount/dir age. Not worth pinning precisely — the fix
   should assume "up to a few seconds."
3. **`-o noattrcache` performance cost** on a large real space (an RPC per
   stat). Not yet benchmarked.

Resolved by the experiments: the seed→sustain mechanism (arm_a), readdir
collapse (arm_b/d/e), the reality of the E4 false-negative (arm_f), that
FUSE-T/NFS _does_ bound staleness by age but not fast enough, and that bumping
mtime is not a reliable fix while `-o noattrcache` is.

## Experimental apparatus (what was actually run)

The claims under test are all about the **macOS NFS client ↔ FUSE-T** layer, not
about CF's bridge specifically. Rather than stand up the whole CF backend (whose
bridge would be an uncontrolled confound), the experiments used a purpose-built
**synthetic FUSE-T filesystem** giving full daemon-side control:

- `synthfs.c` — ~120-line high-level libfuse filesystem linked against
  `libfuse-t`. Exposes `/dir/pre` (always exists; positive control) and
  `/dir/target` (begins to exist at a shared absolute epoch — the daemon-side
  "file appears" event, changed with **zero** client-side syscalls so it can't
  perturb the caches under test). Every kernel request is logged with an
  epoch-ms timestamp, so we can see exactly which stats/readdirs reached the
  daemon versus were served from the client cache. An env flag makes `/dir`'s
  mtime constant (models CF, whose `buildNodeStat` sends no timestamps) or bump
  when the file appears (models the proposed fix).
- `driver.py` — issues stat/readdir sequences on a shared clock and prints
  structured events; arms A–F below.
- `run_arm.sh` — fresh mount per run; correlates driver events against the
  daemon log. `MOPTS="-o noattrcache"` toggles the mount option.

Faithfulness: the high-level vs. CF's low-level libfuse API differ only in how
the daemon computes replies — _above_ the FUSE-T→NFS translation and the macOS
NFS client, which is where every cache under test lives. So the caching
semantics observed are the same ones CF is subject to. (The one CF-specific
question — what seeds the _first_ ENOENT — is addressed by E1 and is now largely
moot; see results.) The harness and raw logs are attached to the session.

To reproduce against the **real** CF stack instead (still worthwhile as a
cross-check): `deno task cf fuse mount --debug /tmp/cf`, deploy a piece with a
callable, mutate it **only via the cf CLI/API, never through the mount**, and
watch `nfsstat -c` deltas plus the bridge `--debug` log and
`~/Library/Logs/fuse-t`.

## Experiments and results

### arm_a — Negative-cache persistence (claim 2) — CONFIRMED

Seed one ENOENT (stat absent target), then poll `stat` every 0.5 s after the
file appears daemon-side. **Result:** the daemon logged
`getattr target ->
ENOENT` exactly **once** (the first seed); the file appeared
at t=8 s but stat kept returning ENOENT until **t=57.7 s — a 49.7 s stale
window** — during which ~100 stats produced no daemon traffic at all. Direct
signature of the negative name cache, and ~50× the old 1 s poll budget. When it
finally cleared, the resolving stat was the first to reach the daemon again.

### arm_b — Does a readdir collapse the window? (claim 3) — CONFIRMED

Same seed, but after three stale stats do **one** `listdir(dir)` then stat.
**Result:** the listdir returned `['pre','target']`, the daemon logged a
READDIRPLUS-driven `getattr target -> file(EXISTS)`, and the very next stat
succeeded — window collapsed from ~50 s to ~0. arm_d/arm_e further showed that a
readdir _interleaved with or preceding_ the stats keeps the negative entry from
ever persisting: with readdir in the loop, **every** stat reached the daemon.
Key nuance: this holds only when the readdir itself reaches the daemon.

### arm_f — The residual false-negative (E4) — REAL, REPRODUCED

Order matters: (1) one `listdir` caches a _stale_ listing `['pre']` and starts
its validity clock; (2) a stat seeds a negative entry _after_ that readdir so it
persists, kept alive with pure stats (no more readdir); (3) the file appears;
(4) after a short gap, run the PR's exact fallback once (stat; on ENOENT, one
readdir). **Result:** when the fallback readdir landed with listing age ≈2.6 s
(inside the directory attribute-cache validity window), it was served the
**stale cached listing `['pre']` with no daemon readdir at all** →
`target_present=False` → **false ENOENT, zero retries**, file existing. At
listing age ≳3 s the listing had aged out and the readdir revalidated → correct.
Reproduced across multiple runs; frequency is timing-dependent (the window is
narrow, but it is the intermittent-"file not found" class of bug).

### arm_f with bumped dir mtime (E5) — the proposed fix FAILS

Re-ran arm_f with `/dir` mtime bumping when the file appears. **Result:** still
produced false-negatives. In the failing runs the daemon received **no
post-appear `getattr /dir` at all** — inside the validity window the client
serves the cached listing without revalidating the directory, so it never issues
the getattr that would reveal the new mtime. Bumping mtime only helps _after_
the attr cache expires, by which point a plain readdir revalidates anyway.
**Conclusion: bumping directory mtimes does not reliably close the E4 window.**
(Separately: with constant mtime the client still eventually revalidates on age,
so FUSE-T/NFS does bound staleness — it just doesn't do so fast enough to make
the zero-retry fallback safe.)

### arm_a + arm_f with `-o noattrcache` (E6) — FIXES BOTH

Re-ran with the mount option. **Result:** arm_a's stale window fell from ~50 s
to **0.25 s** (14 target getattrs — every stat reached the daemon); arm_f's
false-negative **disappeared** across all runs (stat always resolves at the
daemon, so the readdir fallback is never even needed). Cost: one RPC per stat —
benchmark `time ls -R` over a large space before adopting globally.

### E1 — what seeds the first ENOENT — now largely moot

The original open question (does CF's bridge hydration-failure catch at
`mod.ts:1000-1002` seed the ENOENT, or a bridge race, or FUSE-T itself?) matters
much less than we thought: arm_a shows that **whatever** produces a single
ENOENT — a genuine absence, the hydration catch, or a translation-layer hiccup —
the macOS NFS client sustains it for tens of seconds. Worth a quick bridge-log
confirmation against the real stack, but it no longer changes the fix.

### E7 — Linux control — not run here (no Linux box this session)

Expected from source analysis: no stale window (timeout-0 replies, error-style
ENOENT is not negatively cached, readdir not kernel-cached; `notify_inval_*`
works). Any Linux ENOENT should coincide with a bridge-logged ENOENT. Left for a
Linux runner.

## Follow-ups independent of the experiments

- `packages/fuse/README.md:316-318` claims kernel-cache invalidation via
  `notify_inval_entry`; the `cell-bridge.ts:1495` comment says FUSE-T lacks
  `notify_inval_entry` but implies `notify_inval_inode` works. Both contradict
  the source-confirmed reality (neither works on FUSE-T/NFS). Reconcile.
- The `replyEntry` comment at `mod.ts:910-914` ("keep cache timeouts short" as
  the FUSE-T mitigation) should note that FUSE-T ignores those timeouts
  entirely; the timeouts only govern Linux.
- **Do not** rely on surfacing real/bumped directory mtimes from `buildNodeStat`
  as _the_ fix — arm_f (E5) showed the client serves cached listings inside the
  attribute-cache validity window without revalidating, so it never sees the new
  mtime. (It may still be worth doing for other consumers, but it does not close
  the `cf exec` race.)

## Recommended fix options (post-experiment)

Ranked by the evidence above:

1. **Single bounded retry on the readdir-fallback-miss path** (code-level,
   preferred). In `assertMountedCallableFileExists`, if the stat ENOENTs _and_
   the fallback readdir also misses, sleep ~1–2 s (enough to cross the directory
   attribute-cache validity window) and readdir once more before failing. This
   puts latency only on the miss path, a genuinely absent file still fails after
   one extra readdir, and it closes the zero-retry false-negative that removing
   _all_ retries introduced. Much cheaper than the old 20×50 ms stat poll and,
   unlike it, actually escapes the negative cache (readdir, not stat).
2. **Mount with `-o noattrcache`** (systemic). Eliminates the negative-name and
   listing caches wholesale; both the 50 s window and the E4 race vanish. Cost:
   an RPC per stat — measure before adopting for all mounts.
3. Keep the PR as-is only if the just-appeared-callable race is judged
   acceptable for `cf exec` (agents typically `ls` before `exec`, and an
   interleaved readdir prevents the negative cache from persisting — arm_d/e).
   The failure is intermittent, not systematic.

## Primary sources

- [FUSE-T wiki — options, unsupported features, caveats](https://github.com/macos-fuse-t/fuse-t/wiki)
- [Apple `mount_nfs(8)` source (aosm/NFS)](https://github.com/aosm/NFS/blob/master/mount_nfs/mount_nfs.8)
  — `acregmin`/`acdirmin` defaults, `nonegnamecache`
- [xnu `bsd/nfs/nfs_vnops.c`](https://github.com/apple/darwin-xnu/blob/main/bsd/nfs/nfs_vnops.c)
  — `nfs_vnop_lookup` (negative cache behind `NGA_CACHED`), `nfs_vnop_readdir`
  (`NGA_UNCACHED` at offset 0)
- [libfuse wiki — Fsnotify and FUSE](https://github.com/libfuse/libfuse/wiki/Fsnotify-and-FUSE)
- This repo: `packages/fuse/mod.ts` (`replyEntry`, lookup callback, notify
  fallbacks, mount args), `packages/fuse/cell-bridge.ts` (`prepareLookup`/
  `prepareDirectory`, prop-subtree clear), `packages/fuse/stat.ts` (no
  timestamps), `packages/cli/lib/exec.ts` (the code PR #4642 changes)
